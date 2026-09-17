import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../../core/network/api_exception.dart';
import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'talk.dart';
import 'talk_history_api_repository.dart';

class ApiTalkRepository
    implements TalkRepository, TalkHistoryRepository, TalkArtifactRepository {
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
      'computer'
          when artifact.sourceRunId != null &&
              RegExp(r'^[a-zA-Z0-9_-]{1,200}$')
                  .hasMatch(artifact.sourceRunId!) =>
        NativePaths.evidenceRunComputerFrame(artifact.sourceRunId!, assetId),
      'image' || 'video' => NativePaths.captureAssetGet(assetId, content: true),
      _ => throw StateError('This artifact source is not supported.'),
    };
    final bytes = await api.getBytes(path);
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
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
  }) async* {
    final recoveryAnchor = await _captureRecoveryAnchor(threadId);
    String? observedThreadId = threadId;
    var receivedTerminalEvent = false;
    try {
      final body = await api.postStream(
        NativePaths.conversationSend,
        data: {
          'message': message,
          'threadId': ?threadId,
          'mode': mode,
          'strategy': strategy,
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
      // Some production proxies close long-lived response bodies after the
      // governed action has already started. Reconcile only an exact owned
      // thread (or one unambiguous newly-created owned thread) and never rerun
      // the command, which could duplicate a consequential tool action.
      if (!receivedTerminalEvent && recoveryAnchor != null) {
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
          recoveryAnchor,
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
      filename: 'voice-draft.m4a',
      contentType: 'audio/mp4',
      fileField: 'audio',
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
