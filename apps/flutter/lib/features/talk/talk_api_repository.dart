import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../../core/network/api_exception.dart';
import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'talk.dart';
import 'talk_history_api_repository.dart';

class ApiTalkRepository
    implements
        TalkRepository,
        TalkCommandContextRepository,
        TalkCommandModelSelectionRepository,
        TalkHistoryRepository,
        TalkArtifactRepository,
        TalkPromptQueueRepository {
  ApiTalkRepository(
    this.api, {
    TalkHistoryRepository? history,
    Duration recoveryPollInterval = const Duration(seconds: 3),
    int recoveryPollLimit = 200,
  }) : _history = history ?? ApiTalkHistoryRepository(api),
       _recoveryPollInterval = recoveryPollInterval.isNegative
           ? Duration.zero
           : recoveryPollInterval,
       _recoveryPollLimit = recoveryPollLimit.clamp(0, 200);
  static const agentStreamReceiveTimeout = Duration(minutes: 10);
  final ApiClient api;
  final TalkHistoryRepository _history;
  final Duration _recoveryPollInterval;
  final int _recoveryPollLimit;
  static const _promptQueuePath = '/api/command/prompt-queue';
  static const _promptQueueOutboxPath = 'asael://prompt-queue-outbox-v1';
  Future<void> _promptQueueOutboxSerial = Future<void>.value();

  @override
  Future<List<TalkQueuedPrompt>> listPromptQueue() async {
    final payload = await api.getJson(_promptQueuePath);
    final items = _promptQueueItems(payload);
    return _applyPromptQueueOutbox(items, await _readPromptQueueOutbox());
  }

  @override
  Future<TalkQueuedPrompt> createPromptQueueItem(
    TalkQueuedPrompt prompt,
  ) async {
    final operation = <String, dynamic>{
      'kind': 'create',
      'clientCorrelationId': prompt.clientCorrelationId,
      'request': _promptQueueCreateRequest(prompt),
    };
    try {
      final response = await api.postJson(
        _promptQueuePath,
        data: Map<String, dynamic>.from(operation['request'] as Map),
      );
      return _promptQueueItem(response['item']);
    } on ApiException catch (error) {
      if (!_isOfflineQueueFailure(error)) rethrow;
      await _appendPromptQueueOperation(operation);
      return prompt.copyWith(syncState: TalkPromptQueueSyncState.pending);
    }
  }

  @override
  Future<TalkQueuedPrompt> updatePromptQueueItem(
    TalkQueuedPrompt prompt, {
    String? input,
    String? state,
  }) async {
    final operation = <String, dynamic>{
      'kind': 'update',
      'id': prompt.id,
      'clientCorrelationId': prompt.clientCorrelationId,
      'expectedRevision': prompt.lifecycleRevision,
      'input': ?input,
      'state': ?state,
    };
    if (!prompt.serverBacked) {
      await _appendPromptQueueOperation(operation);
      return prompt.copyWith(
        input: input,
        state: state,
        lifecycleRevision: prompt.lifecycleRevision + 1,
        syncState: TalkPromptQueueSyncState.pending,
      );
    }
    try {
      final response = await api.patchJson(
        '$_promptQueuePath/${Uri.encodeComponent(prompt.id)}',
        data: {
          'expectedRevision': prompt.lifecycleRevision,
          'prompt': ?input,
          'state': ?state,
        },
      );
      return _promptQueueItem(response['item']);
    } on ApiException catch (error) {
      if (!_isOfflineQueueFailure(error)) rethrow;
      await _appendPromptQueueOperation(operation);
      return prompt.copyWith(
        input: input,
        state: state,
        lifecycleRevision: prompt.lifecycleRevision + 1,
        syncState: TalkPromptQueueSyncState.pending,
      );
    }
  }

  @override
  Future<void> deletePromptQueueItem(TalkQueuedPrompt prompt) async {
    final operation = <String, dynamic>{
      'kind': 'delete',
      'id': prompt.id,
      'clientCorrelationId': prompt.clientCorrelationId,
      'expectedRevision': prompt.lifecycleRevision,
    };
    if (!prompt.serverBacked) {
      await _appendPromptQueueOperation(operation);
      return;
    }
    try {
      await api.deleteJson(
        '$_promptQueuePath/${Uri.encodeComponent(prompt.id)}',
        data: {'expectedRevision': prompt.lifecycleRevision},
      );
    } on ApiException catch (error) {
      if (!_isOfflineQueueFailure(error)) rethrow;
      await _appendPromptQueueOperation(operation);
    }
  }

  @override
  Future<List<TalkQueuedPrompt>> reorderPromptQueue(
    List<TalkQueuedPrompt> prompts,
  ) async {
    final operation = <String, dynamic>{
      'kind': 'reorder',
      'items': [
        for (final prompt in prompts)
          {
            'id': prompt.id,
            'clientCorrelationId': prompt.clientCorrelationId,
            'expectedRevision': prompt.lifecycleRevision,
          },
      ],
    };
    if (prompts.any((prompt) => !prompt.serverBacked)) {
      await _appendPromptQueueOperation(operation);
      return [
        for (final prompt in prompts)
          prompt.copyWith(
            lifecycleRevision: prompt.lifecycleRevision + 1,
            syncState: TalkPromptQueueSyncState.pending,
          ),
      ];
    }
    try {
      final response = await api.postJson(
        '$_promptQueuePath/reorder',
        data: {
          'items': [
            for (final prompt in prompts)
              {'id': prompt.id, 'expectedRevision': prompt.lifecycleRevision},
          ],
        },
      );
      return _promptQueueItems(response);
    } on ApiException catch (error) {
      if (!_isOfflineQueueFailure(error)) rethrow;
      await _appendPromptQueueOperation(operation);
      return [
        for (final prompt in prompts)
          prompt.copyWith(
            lifecycleRevision: prompt.lifecycleRevision + 1,
            syncState: TalkPromptQueueSyncState.pending,
          ),
      ];
    }
  }

  @override
  Stream<SseEvent> dispatchPromptQueueItem(
    TalkQueuedPrompt prompt, {
    required bool force,
  }) async* {
    if (!prompt.serverBacked) {
      throw const ApiException(
        'Reconnect before running this locally queued prompt.',
        diagnosticCode: 'prompt_queue_offline_pending',
      );
    }
    final body = await api.postStream(
      '$_promptQueuePath/${Uri.encodeComponent(prompt.id)}/dispatch',
      data: {'expectedRevision': prompt.lifecycleRevision, 'force': force},
      headers: const {'Accept': 'text/event-stream'},
      receiveTimeout: agentStreamReceiveTimeout,
    );
    await for (final event in parseSse(body.stream)) {
      yield event;
    }
  }

  @override
  Future<List<TalkQueuedPrompt>> reconcilePromptQueue() async {
    return _serializePromptQueueOutbox(() async {
      var operations = await _readPromptQueueOutboxUnsafe();
      if (operations.isEmpty) {
        return _promptQueueItems(await api.getJsonFresh(_promptQueuePath));
      }
      final conflictCorrelations = <String>{};
      while (operations.isNotEmpty) {
        final operation = operations.first;
        try {
          await _replayPromptQueueOperation(operation);
          operations = operations.sublist(1);
          // Persist after every acknowledged operation. A process death can
          // replay only the current idempotent operation, never the full tail.
          await _writePromptQueueOutboxUnsafe(operations);
        } on ApiConflictException {
          conflictCorrelations.addAll(_operationCorrelations(operation));
          break;
        }
      }
      final live = _promptQueueItems(await api.getJsonFresh(_promptQueuePath));
      return [
        for (final item in _applyPromptQueueOutbox(live, operations))
          conflictCorrelations.contains(item.clientCorrelationId)
              ? item.copyWith(syncState: TalkPromptQueueSyncState.conflict)
              : item,
      ];
    });
  }

  Future<List<Json>> _readPromptQueueOutbox() =>
      _serializePromptQueueOutbox(_readPromptQueueOutboxUnsafe);

  Future<List<Json>> _readPromptQueueOutboxUnsafe() async {
    final projection = await api.readOfflineProjection(_promptQueueOutboxPath);
    if (projection == null) return const [];
    if (projection['schemaVersion'] != 1 || projection['operations'] is! List) {
      throw const FormatException(
        'The private prompt queue outbox is invalid.',
      );
    }
    final raw = projection['operations'] as List;
    if (raw.length > 80 || raw.any((operation) => operation is! Map)) {
      throw const FormatException(
        'The private prompt queue outbox is invalid.',
      );
    }
    return [
      for (final operation in raw) Map<String, dynamic>.from(operation as Map),
    ];
  }

  Future<void> _writePromptQueueOutboxUnsafe(List<Json> operations) async {
    if (operations.length > 80) {
      throw StateError('The private prompt queue outbox is full.');
    }
    await api.seedOfflineProjection(_promptQueueOutboxPath, {
      'schemaVersion': 1,
      'operations': operations,
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    });
  }

  Future<void> _appendPromptQueueOperation(Json operation) =>
      _serializePromptQueueOutbox(() async {
        final operations = await _readPromptQueueOutboxUnsafe();
        if (operations.length >= 80) {
          throw StateError(
            'The offline prompt queue has too many pending changes. Reconnect before changing it again.',
          );
        }
        await _writePromptQueueOutboxUnsafe([...operations, operation]);
      });

  Future<T> _serializePromptQueueOutbox<T>(Future<T> Function() action) {
    final result = _promptQueueOutboxSerial.then((_) => action());
    _promptQueueOutboxSerial = result.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    return result;
  }

  Future<void> _replayPromptQueueOperation(Json operation) async {
    final kind = operation['kind'];
    if (kind == 'create') {
      final request = operation['request'];
      if (request is! Map) {
        throw const FormatException('An offline queue create is invalid.');
      }
      await api.postJson(
        _promptQueuePath,
        data: Map<String, dynamic>.from(request),
      );
      return;
    }

    final live = _promptQueueItems(await api.getJsonFresh(_promptQueuePath));
    if (kind == 'update') {
      final current = _resolvePromptQueueOperationItem(live, operation);
      if (current == null) {
        throw const ApiConflictException(
          'This queued prompt no longer exists on the server.',
        );
      }
      final desiredInput = operation['input']?.toString();
      final desiredState = operation['state']?.toString();
      final expectedRevision = _queueRevision(operation['expectedRevision']);
      if (current.lifecycleRevision == expectedRevision + 1 &&
          (desiredInput == null || current.input == desiredInput) &&
          (desiredState == null || current.state == desiredState)) {
        return;
      }
      await api.patchJson(
        '$_promptQueuePath/${Uri.encodeComponent(current.id)}',
        data: {
          'expectedRevision': expectedRevision,
          'prompt': ?desiredInput,
          'state': ?desiredState,
        },
      );
      return;
    }
    if (kind == 'delete') {
      final current = _resolvePromptQueueOperationItem(live, operation);
      if (current == null) return;
      try {
        await api.deleteJson(
          '$_promptQueuePath/${Uri.encodeComponent(current.id)}',
          data: {
            'expectedRevision': _queueRevision(operation['expectedRevision']),
          },
        );
      } on ApiException catch (error) {
        if (error.statusCode != 404) rethrow;
      }
      return;
    }
    if (kind == 'reorder') {
      final rawItems = operation['items'];
      if (rawItems is! List || rawItems.isEmpty || rawItems.length > 40) {
        throw const FormatException('An offline queue reorder is invalid.');
      }
      final resolved = <({TalkQueuedPrompt item, int expectedRevision})>[];
      for (final raw in rawItems) {
        if (raw is! Map) {
          throw const FormatException('An offline queue reorder is invalid.');
        }
        final queueItem = _resolvePromptQueueOperationItem(
          live,
          Map<String, dynamic>.from(raw),
        );
        if (queueItem == null) {
          throw const ApiConflictException(
            'The prompt queue changed before offline order could sync.',
          );
        }
        resolved.add((
          item: queueItem,
          expectedRevision: _queueRevision(raw['expectedRevision']),
        ));
      }
      final liveActive = live
          .where((item) => item.state == 'queued' || item.state == 'paused')
          .map((item) => item.id)
          .toList(growable: false);
      final desired = resolved.map((value) => value.item.id).toList();
      final alreadyApplied =
          _sameQueueOrder(liveActive, desired) &&
          resolved.every(
            (value) =>
                value.item.lifecycleRevision == value.expectedRevision + 1,
          );
      if (alreadyApplied) return;
      await api.postJson(
        '$_promptQueuePath/reorder',
        data: {
          'items': [
            for (final value in resolved)
              {'id': value.item.id, 'expectedRevision': value.expectedRevision},
          ],
        },
      );
      return;
    }
    throw const FormatException('An offline queue operation is invalid.');
  }

  @override
  Future<void> cancelRun(String runId) async {
    await api.deleteJson(
      NativePaths.evidenceRunCancel(runId),
      headers: {
        'idempotency-key':
            'conversation-cancel-$runId-${DateTime.now().microsecondsSinceEpoch}',
      },
    );
  }

  @override
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId) async {
    final json = await api.getJson(
      NativePaths.evidenceWorkflow(workflowId),
      query: const {'view': 'status'},
    );
    final snapshot = TalkWorkflowSnapshot.fromJson(json);
    if (snapshot.id != workflowId) {
      throw StateError('The workflow projection did not match the request.');
    }
    return snapshot;
  }

  @override
  Future<TalkRunInspection> inspectRun(String runId) async {
    final inspection = TalkRunInspection.fromJson(
      await api.getJson(NativePaths.evidenceRun(runId)),
    );
    if (inspection.runId != runId) {
      throw StateError('The run projection did not match the request.');
    }
    return inspection;
  }

  @override
  Future<TalkArtifactContent> loadArtifact(
    TalkMediaArtifactSummary artifact,
  ) async {
    final assetId = artifact.assetId;
    if (!RegExp(r'^[a-zA-Z0-9_-]{1,200}$').hasMatch(assetId)) {
      throw ArgumentError.value(assetId, 'assetId');
    }
    final path = switch (artifact.kind) {
      'computer' => throw const LegacyComputerPreviewRetired(),
      'image' || 'video' => NativePaths.captureAssetGet(assetId, content: true),
      'presentation' when artifact.isPresentation =>
        NativePaths.artifactsContent(
          assetId,
          version: artifact.artifactVersion,
        ),
      _ => throw StateError('This artifact source is not supported.'),
    };
    final bytes = await api.getBytes(path);
    if (artifact.isPresentation && bytes.length != artifact.byteCount) {
      throw const FormatException(
        'The generated artifact did not match its verified projection.',
      );
    }
    return TalkArtifactContent(assetId: assetId, bytes: bytes);
  }

  @override
  Future<List<TalkThreadSummary>> listThreads({int limit = 30}) =>
      _history.listThreads(limit: limit);

  @override
  Future<TalkThreadDetail> getThread(String threadId) =>
      _history.getThread(threadId);

  @override
  Future<List<TalkThreadMemorySummary>> listThreadMemories(
    String threadId, {
    int limit = 24,
  }) => _history.listThreadMemories(threadId, limit: limit);

  @override
  Future<TalkCommandContextCatalog> loadCommandContextCatalog() async {
    final payload = await api.getJson('/api/command/catalog');
    return TalkCommandContextCatalog.fromJson(payload);
  }

  @override
  Future<TalkCommandModelCatalog> loadCommandModelCatalog({
    required String commandScope,
  }) async {
    final payload = await api.getJsonFresh(
      NativePaths.settingsModelsCommandCatalog(commandScope: commandScope),
    );
    return TalkCommandModelCatalog.fromJson(payload);
  }

  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    String? agentId,
    TalkCommandModelSelection? modelSelection,
  }) => _sendAgent(
    message: message,
    threadId: threadId,
    mode: mode,
    strategy: strategy,
    executionTarget: executionTarget,
    agentId: agentId,
    contextReferences: const [],
    modelSelection: modelSelection,
  );

  @override
  Stream<SseEvent> sendWithCommandContext({
    required String message,
    required List<TalkCommandContextReference> contextReferences,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    String? agentId,
    TalkCommandModelSelection? modelSelection,
  }) => _sendAgent(
    message: message,
    threadId: threadId,
    mode: mode,
    strategy: strategy,
    executionTarget: executionTarget,
    agentId: agentId,
    contextReferences: contextReferences,
    modelSelection: modelSelection,
  );

  Stream<SseEvent> _sendAgent({
    required String message,
    required List<TalkCommandContextReference> contextReferences,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    String? agentId,
    TalkCommandModelSelection? modelSelection,
  }) async* {
    final selectedAgents = contextReferences
        .where((item) => item.kind == 'agent')
        .toList(growable: false);
    final selectedProjects = contextReferences
        .where((item) => item.kind == 'project')
        .toList(growable: false);
    if (selectedAgents.length > 1 || selectedProjects.length > 1) {
      throw const FormatException(
        'A Command can select only one primary Agent and one Project.',
      );
    }
    final requestedAgentId = agentId?.trim();
    final selectedAgentId = selectedAgents.firstOrNull?.id;
    if (requestedAgentId != null &&
        selectedAgentId != null &&
        requestedAgentId != selectedAgentId) {
      throw const FormatException(
        'The selected Agent did not match the Command assignment.',
      );
    }
    final exactAgentId = requestedAgentId ?? selectedAgentId;
    if (exactAgentId != null &&
        !RegExp(r'^[a-zA-Z0-9_.:-]{1,120}$').hasMatch(exactAgentId)) {
      throw ArgumentError.value(agentId, 'agentId');
    }
    final recoveryAnchor = _captureRecoveryAnchor(threadId);
    String? observedThreadId = threadId;
    String? observedRunId;
    var receivedTerminalEvent = false;
    try {
      final body = await api.postStream(
        NativePaths.conversationSend,
        data: {
          'message': message,
          'threadId': ?threadId,
          'mode': mode,
          'strategy': strategy,
          'agentId': ?exactAgentId,
          'projectId': ?selectedProjects.firstOrNull?.id,
          if (contextReferences.isNotEmpty)
            'contextReferences': [
              for (final reference in contextReferences)
                reference.toRequestJson(),
            ],
          if (modelSelection != null)
            'modelSelection': modelSelection.toRequestJson(),
          'computerUseTarget': ?executionTarget.apiValue,
          'requestId': 'flutter-${DateTime.now().microsecondsSinceEpoch}',
        },
        headers: const {'Accept': 'text/event-stream'},
        // Computer-use and delegated tool turns can legitimately spend longer
        // than the ordinary projection timeout between response bytes.
        receiveTimeout: agentStreamReceiveTimeout,
      );
      await for (final event in parseSse(body.stream)) {
        final projectedThreadId = safeTalkHistoryId(event.data['threadId']);
        if (projectedThreadId.isNotEmpty) observedThreadId = projectedThreadId;
        if (event.event == 'run') {
          final projectedRunId = safeTalkHistoryId(event.data['runId']);
          if (projectedRunId.isEmpty) {
            throw const FormatException(
              'The governed run identity was invalid.',
            );
          }
          observedRunId = projectedRunId;
        }
        receivedTerminalEvent =
            receivedTerminalEvent ||
            _terminalConversationEvents.contains(event.event);
        yield event;
      }
      if (receivedTerminalEvent) return;
      throw const ApiException(
        'The live connection ended before the governed run completed. The run may still finish in History.',
        diagnosticCode: 'stream_ended_without_terminal_event',
      );
    } catch (error, stackTrace) {
      // A streamed run identity proves that the server accepted this exact
      // actor-owned operation. Never turn a transport loss after acceptance
      // into a second POST; the controller continues through GET /api/runs/:id.
      if (!receivedTerminalEvent && observedRunId != null) {
        yield SseEvent(
          event: 'status',
          data: {
            'type': 'status',
            'label': 'Reconnecting to this run',
            'detail': 'The live view disconnected. Asael is following the original governed run.',
            'runId': observedRunId,
            'threadId': ?observedThreadId,
          },
        );
        return;
      }
      // Some production proxies close long-lived response bodies after the
      // governed action has already started but before the run event arrived.
      // Only this no-run-id branch may use actor-scoped thread history, and it
      // remains fail-closed if a single exact turn cannot be identified.
      final fallbackAnchor = await recoveryAnchor;
      // A custom-Agent request must never adopt an actor-concurrent history
      // turn without first proving that turn's logical Agent identity. The
      // native history projection does not carry that proof, so this legacy
      // no-run-id heuristic is available only to ordinary supervisor routing.
      if (!receivedTerminalEvent &&
          fallbackAnchor != null &&
          exactAgentId == null) {
        yield SseEvent(
          event: 'status',
          data: {
            'type': 'status',
            'label': 'Recovering completed work',
            'detail': 'The live view disconnected. Asael is reconciling the original governed run.',
            'threadId': ?observedThreadId,
          },
        );
        final recovered = await _recoverCompletedTurn(
          fallbackAnchor,
          observedThreadId: observedThreadId,
          message: message,
          mode: mode,
        );
        if (recovered != null) {
          final runId = recovered.turn.runId;
          if (runId != null) {
            yield SseEvent(
              event: 'run',
              data: {
                'type': 'run',
                'runId': runId,
                'threadId': recovered.threadId,
              },
            );
          }
          yield SseEvent(
            event: 'done',
            data: {
              'type': 'done',
              'threadId': recovered.threadId,
              'response': recovered.turn.text,
            },
          );
          return;
        }
      }
      final normalized = error is DioException
          ? ApiException.fromDio(error)
          : error;
      Error.throwWithStackTrace(normalized, stackTrace);
    }
  }

  Future<_TalkRecoveryAnchor?> _captureRecoveryAnchor(String? threadId) async {
    try {
      if (threadId != null) {
        final detail = await _history.getThread(threadId);
        return _TalkRecoveryAnchor(
          threadId: threadId,
          baselineThreadIds: const {},
          baselineAssistantSignatures: _assistantSignatures(detail),
        );
      }
      final threads = await _history.listThreads(limit: 100);
      return _TalkRecoveryAnchor(
        baselineThreadIds: {for (final thread in threads) thread.id},
        baselineAssistantSignatures: const {},
      );
    } catch (_) {
      // Recovery is fail-closed. The command may still use its normal stream,
      // but without an actor-scoped baseline we will not guess at a result.
      return null;
    }
  }

  Future<_RecoveredTalkTurn?> _recoverCompletedTurn(
    _TalkRecoveryAnchor anchor, {
    required String? observedThreadId,
    required String message,
    required String mode,
  }) async {
    if (_recoveryPollLimit < 1) return null;
    String? candidateId = observedThreadId ?? anchor.threadId;
    final expectedTitle = _expectedThreadTitle(message);
    for (var attempt = 0; attempt < _recoveryPollLimit; attempt += 1) {
      if (attempt > 0 && _recoveryPollInterval > Duration.zero) {
        await Future<void>.delayed(_recoveryPollInterval);
      }
      try {
        if (candidateId == null) {
          final threads = await _history.listThreads(limit: 100);
          final candidates = threads
              .where(
                (thread) =>
                    !anchor.baselineThreadIds.contains(thread.id) &&
                    thread.mode == mode,
              )
              .toList(growable: false);
          if (candidates.length == 1) {
            candidateId = candidates.single.id;
          } else if (candidates.length > 1) {
            final matching = candidates
                .where((thread) => thread.title == expectedTitle)
                .toList(growable: false);
            if (matching.length == 1) candidateId = matching.single.id;
          }
        }
        final exactId = candidateId;
        if (exactId == null) continue;
        final detail = await _history.getThread(exactId);
        for (final turn in detail.turns.reversed) {
          if (turn.role != TalkThreadRole.assistant) continue;
          final signature = _assistantSignature(turn);
          if (!anchor.baselineAssistantSignatures.contains(signature)) {
            return _RecoveredTalkTurn(threadId: exactId, turn: turn);
          }
        }
      } catch (_) {
        // A transient projection read cannot authorize another execution. Keep
        // polling the exact actor-scoped history until the bounded window ends.
      }
    }
    return null;
  }

  @override
  Future<String> transcribeVoice(Uint8List bytes) async {
    final json = await api.postMultipart(
      NativePaths.captureTranscribe,
      fields: const {},
      bytes: bytes,
      filename: 'voice-draft.wav',
      contentType: 'audio/wav',
      fileField: 'audio',
      receiveTimeout: const Duration(seconds: 90),
    );
    final text = json['text'];
    if (text is! String || text.trim().isEmpty) {
      throw StateError('The voice draft did not contain transcribable speech.');
    }
    return text;
  }
}

const _terminalConversationEvents = {
  'done',
  'error',
  'canceled',
  'delegated',
  'clarification',
  'waiting_approval',
  'budget_exhausted',
};

List<TalkQueuedPrompt> _promptQueueItems(Map<String, dynamic> payload) {
  final rawItems = payload['items'];
  if (rawItems is! List || rawItems.length > 40) {
    throw const FormatException('The prompt queue projection is invalid.');
  }
  return [for (final raw in rawItems) _promptQueueItem(raw)];
}

TalkQueuedPrompt _promptQueueItem(Object? value) {
  if (value is! Map) {
    throw const FormatException('A prompt queue item is invalid.');
  }
  final item = Map<String, dynamic>.from(value);
  final schemaVersion = item['schemaVersion'];
  final id = _queueText(item['id'], maximum: 80);
  final correlation = _queueText(item['clientCorrelationId'], maximum: 240);
  final prompt = _queueText(item['prompt'], maximum: 20000);
  final mode = _queueText(item['mode'], maximum: 20);
  final strategy = _queueText(item['strategy'], maximum: 20);
  final state = _queueText(item['state'], maximum: 20);
  final revision = _queueRevision(item['lifecycleRevision']);
  final target = item['target'];
  final agent = item['agent'];
  final model = item['model'];
  if (schemaVersion != 1 ||
      !RegExp(
        r'^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',
        caseSensitive: false,
      ).hasMatch(id) ||
      correlation.isEmpty ||
      prompt.isEmpty ||
      !const {'orchestrate', 'research', 'execute', 'learn'}.contains(mode) ||
      !const {'direct', 'auto'}.contains(strategy) ||
      !const {
        'queued',
        'paused',
        'dispatching',
        'completed',
        'failed',
      }.contains(state) ||
      target is! Map ||
      agent is! Map ||
      model is! Map ||
      item['queueGrantsAuthority'] != false) {
    throw const FormatException('A prompt queue item is invalid.');
  }
  final targetMap = Map<String, dynamic>.from(target);
  final agentMap = Map<String, dynamic>.from(agent);
  final modelMap = Map<String, dynamic>.from(model);
  final executionTarget = targetMap['executionTarget'] == 'local_macos'
      ? TalkExecutionTarget.thisMac
      : targetMap['executionTarget'] == 'asael'
      ? TalkExecutionTarget.agent
      : throw const FormatException('The queue execution target is invalid.');
  final logicalAgentId = _queueText(agentMap['logicalAgentId'], maximum: 120);
  final providerId = _queueText(modelMap['providerId'], maximum: 40);
  final modelId = _queueText(modelMap['modelId'], maximum: 240);
  final definitionVersion = _queueRevision(agentMap['definitionVersion']);
  if (logicalAgentId.isEmpty ||
      providerId.isEmpty ||
      modelId.isEmpty ||
      definitionVersion < 1) {
    throw const FormatException('The queue identity pin is invalid.');
  }
  return TalkQueuedPrompt(
    id: id,
    clientCorrelationId: correlation,
    input: prompt,
    mode: mode,
    strategy: strategy,
    executionTarget: executionTarget,
    assignedAgent: TalkAssignedAgent(
      id: logicalAgentId,
      name: logicalAgentId == 'atlas' ? 'Asael' : logicalAgentId,
    ),
    threadId: _queueNullableText(targetMap['threadId'], maximum: 240),
    lifecycleRevision: revision,
    state: state,
    providerId: providerId,
    modelId: modelId,
    agentDefinitionVersion: definitionVersion,
    progressLabel: _queueNullableText(item['progressLabel'], maximum: 160),
    failureCode: _queueNullableText(item['failureCode'], maximum: 240),
  );
}

Json _promptQueueCreateRequest(TalkQueuedPrompt prompt) => {
  'clientCorrelationId': prompt.clientCorrelationId,
  'prompt': prompt.input,
  'mode': prompt.mode,
  'strategy': prompt.strategy,
  'agentId': prompt.assignedAgent?.id ?? 'atlas',
  'target': {
    'threadId': prompt.threadId,
    'missionId': null,
    'projectId': null,
    'executionTarget': prompt.executionTarget == TalkExecutionTarget.thisMac
        ? 'local_macos'
        : 'asael',
  },
};

List<TalkQueuedPrompt> _applyPromptQueueOutbox(
  List<TalkQueuedPrompt> serverItems,
  List<Json> operations,
) {
  final items = List<TalkQueuedPrompt>.from(serverItems);
  for (final operation in operations.take(80)) {
    final kind = operation['kind'];
    if (kind == 'create') {
      final request = operation['request'];
      if (request is! Map) continue;
      final values = Map<String, dynamic>.from(request);
      final correlation = _queueText(
        operation['clientCorrelationId'],
        maximum: 240,
      );
      if (correlation.isEmpty ||
          items.any((item) => item.clientCorrelationId == correlation)) {
        continue;
      }
      final target = values['target'] is Map
          ? Map<String, dynamic>.from(values['target'] as Map)
          : const <String, dynamic>{};
      final agentId = _queueText(values['agentId'], maximum: 120);
      items.add(
        TalkQueuedPrompt(
          id: 'local-$correlation',
          clientCorrelationId: correlation,
          input: _queueText(values['prompt'], maximum: 20000),
          mode: _queueText(values['mode'], maximum: 20),
          strategy: _queueText(values['strategy'], maximum: 20),
          executionTarget: target['executionTarget'] == 'local_macos'
              ? TalkExecutionTarget.thisMac
              : TalkExecutionTarget.agent,
          assignedAgent: TalkAssignedAgent(
            id: agentId.isEmpty ? 'atlas' : agentId,
            name: agentId.isEmpty || agentId == 'atlas' ? 'Asael' : agentId,
          ),
          threadId: _queueNullableText(target['threadId'], maximum: 240),
          syncState: TalkPromptQueueSyncState.pending,
        ),
      );
      continue;
    }
    if (kind == 'update') {
      final index = _resolvePromptQueueOperationIndex(items, operation);
      if (index < 0) continue;
      final current = items[index];
      items[index] = current.copyWith(
        input: operation['input']?.toString(),
        state: operation['state']?.toString(),
        lifecycleRevision: current.lifecycleRevision + 1,
        syncState: TalkPromptQueueSyncState.pending,
      );
      continue;
    }
    if (kind == 'delete') {
      final index = _resolvePromptQueueOperationIndex(items, operation);
      if (index >= 0) items.removeAt(index);
      continue;
    }
    if (kind == 'reorder' && operation['items'] is List) {
      final requested = operation['items'] as List;
      final active = <TalkQueuedPrompt>[];
      for (final raw in requested.take(40)) {
        if (raw is! Map) continue;
        final index = _resolvePromptQueueOperationIndex(
          items,
          Map<String, dynamic>.from(raw),
        );
        if (index >= 0 && !active.contains(items[index])) {
          active.add(
            items[index].copyWith(
              lifecycleRevision: items[index].lifecycleRevision + 1,
              syncState: TalkPromptQueueSyncState.pending,
            ),
          );
        }
      }
      if (active.length ==
          items
              .where((item) => item.state == 'queued' || item.state == 'paused')
              .length) {
        final terminal = items
            .where((item) => item.state != 'queued' && item.state != 'paused')
            .toList(growable: false);
        items
          ..clear()
          ..addAll(active)
          ..addAll(terminal);
      }
    }
  }
  return items.take(40).toList(growable: false);
}

TalkQueuedPrompt? _resolvePromptQueueOperationItem(
  List<TalkQueuedPrompt> items,
  Map operation,
) {
  final index = _resolvePromptQueueOperationIndex(items, operation);
  return index < 0 ? null : items[index];
}

int _resolvePromptQueueOperationIndex(
  List<TalkQueuedPrompt> items,
  Map operation,
) {
  final correlation = _queueText(
    operation['clientCorrelationId'],
    maximum: 240,
  );
  final id = _queueText(operation['id'], maximum: 240);
  return items.indexWhere(
    (item) =>
        (correlation.isNotEmpty && item.clientCorrelationId == correlation) ||
        (id.isNotEmpty && item.id == id),
  );
}

Set<String> _operationCorrelations(Json operation) {
  final result = <String>{};
  final direct = _queueText(operation['clientCorrelationId'], maximum: 240);
  if (direct.isNotEmpty) result.add(direct);
  final rawItems = operation['items'];
  if (rawItems is List) {
    for (final raw in rawItems.take(40)) {
      if (raw is! Map) continue;
      final correlation = _queueText(raw['clientCorrelationId'], maximum: 240);
      if (correlation.isNotEmpty) result.add(correlation);
    }
  }
  return result;
}

bool _sameQueueOrder(List<String> left, List<String> right) {
  if (left.length != right.length) return false;
  for (var index = 0; index < left.length; index += 1) {
    if (left[index] != right[index]) return false;
  }
  return true;
}

bool _isOfflineQueueFailure(ApiException error) =>
    error.statusCode == null ||
    const {408, 500, 502, 503, 504}.contains(error.statusCode);

int _queueRevision(Object? value) {
  if (value is! num || value < 0 || value > 9007199254740991) {
    throw const FormatException('A prompt queue revision is invalid.');
  }
  return value.toInt();
}

String _queueText(Object? value, {required int maximum}) {
  if (value is! String || value.isEmpty || value.length > maximum) return '';
  if (value.contains(RegExp(r'[\u0000-\u001F\u007F]'))) return '';
  return value;
}

String? _queueNullableText(Object? value, {required int maximum}) {
  if (value == null) return null;
  final text = _queueText(value, maximum: maximum);
  return text.isEmpty ? null : text;
}

class _TalkRecoveryAnchor {
  const _TalkRecoveryAnchor({
    this.threadId,
    required this.baselineThreadIds,
    required this.baselineAssistantSignatures,
  });

  final String? threadId;
  final Set<String> baselineThreadIds;
  final Set<String> baselineAssistantSignatures;
}

class _RecoveredTalkTurn {
  const _RecoveredTalkTurn({required this.threadId, required this.turn});

  final String threadId;
  final TalkThreadTurn turn;
}

Set<String> _assistantSignatures(TalkThreadDetail detail) => {
  for (final turn in detail.turns)
    if (turn.role == TalkThreadRole.assistant) _assistantSignature(turn),
};

String _assistantSignature(TalkThreadTurn turn) =>
    '${turn.runId ?? ''}\u0000${turn.createdAt?.toUtc().toIso8601String() ?? ''}\u0000${turn.text}';

String _expectedThreadTitle(String message) {
  final normalized = message.replaceAll(RegExp(r'\s+'), ' ').trim();
  return String.fromCharCodes(normalized.runes.take(90));
}
