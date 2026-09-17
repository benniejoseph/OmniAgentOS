import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:file_picker/file_picker.dart';
import 'package:go_router/go_router.dart';
import 'package:record/record.dart';

import '../../app/brand/asael_mark.dart';
import '../../core/network/api_exception.dart';
import '../../core/platform/desktop_host_bridge.dart';
import '../../generated/native_contract.g.dart';
import '../computer_use/local_computer.dart';
import 'talk_history.dart';
import 'talk_history_view.dart';

export 'talk_history.dart';

typedef Json = Map<String, dynamic>;

Json _jsonRecord(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

String _boundedDisplayText(Object? value, int maximum) {
  if (value is! String) return '';
  final normalized = value.replaceAll(RegExp(r'\s+'), ' ').trim();
  return normalized.length <= maximum ? normalized : '';
}

({String message, String detail}) _talkFailure(Object error) {
  if (error is ApiException) {
    final code = _boundedDisplayText(error.diagnosticCode, 80);
    return (
      message: _boundedDisplayText(error.message, 400).isNotEmpty
          ? _boundedDisplayText(error.message, 400)
          : 'The live connection ended before the governed run completed.',
      detail: code.isEmpty
          ? 'The live connection ended before the run completed.'
          : 'The live connection ended before the run completed ($code).',
    );
  }
  if (error is FormatException) {
    return (
      message: 'Asael received a live response this app could not read. The completed run may still be available in History.',
      detail: 'The native conversation contract rejected a stream event.',
    );
  }
  if (error is TimeoutException) {
    return (
      message: 'The live response took too long. The governed run may still finish in History.',
      detail: 'The native conversation wait reached its time limit.',
    );
  }
  if (error is StateError) {
    final message = _boundedDisplayText(error.message, 400);
    return (
      message: message.isEmpty
          ? 'Asael could not complete this governed run.'
          : message,
      detail: 'The governed run returned a terminal error.',
    );
  }
  return (
    message: 'The live connection ended before the governed run completed. The run may still finish in History.',
    detail: 'The connection ended before the run completed.',
  );
}

int _boundedCount(
  Object? value, {
  required int fallback,
  required int maximum,
}) {
  if (value is! num) return fallback;
  final count = value.toInt();
  return count >= 0 && count <= maximum ? count : fallback;
}

String? _validatedWebOrigin(String value) {
  if (value.isEmpty) return null;
  final uri = Uri.tryParse(value);
  if (uri == null ||
      !const {'http', 'https'}.contains(uri.scheme) ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.origin != value) {
    return null;
  }
  return uri.origin;
}

class SseEvent {
  const SseEvent({required this.event, required this.data});
  final String event;
  final Json data;
}

/// Handles arbitrary network chunk boundaries, CRLF, comments, multi-line data,
/// and a final event without a trailing blank line.
Stream<SseEvent> parseSse(Stream<List<int>> bytes) async* {
  var buffer = '';
  var eventName = 'message';
  final data = <String>[];
  SseEvent? flush() {
    if (data.isEmpty) {
      eventName = 'message';
      return null;
    }
    final raw = data.join('\n');
    data.clear();
    final name = eventName;
    eventName = 'message';
    final decoded = jsonDecode(raw);
    return SseEvent(
      event: name,
      data: NativeConversationEvents.parse(name, decoded),
    );
  }

  await for (final chunk in bytes.transform(utf8.decoder)) {
    buffer += chunk;
    while (true) {
      final newline = buffer.indexOf('\n');
      if (newline < 0) break;
      var line = buffer.substring(0, newline);
      buffer = buffer.substring(newline + 1);
      if (line.endsWith('\r')) line = line.substring(0, line.length - 1);
      if (line.isEmpty) {
        final value = flush();
        if (value != null) yield value;
        continue;
      }
      if (line.startsWith(':')) continue;
      final colon = line.indexOf(':');
      final field = colon < 0 ? line : line.substring(0, colon);
      var value = colon < 0 ? '' : line.substring(colon + 1);
      if (value.startsWith(' ')) value = value.substring(1);
      if (field == 'event') eventName = value;
      if (field == 'data') data.add(value);
    }
  }
  if (buffer.isNotEmpty) {
    var line = buffer;
    if (line.endsWith('\r')) line = line.substring(0, line.length - 1);
    if (line.startsWith('data:')) data.add(line.substring(5).trimLeft());
  }
  final value = flush();
  if (value != null) yield value;
}

enum TalkRole { user, assistant }

enum TalkActivityState { active, succeeded, waiting, failed, info }

enum TalkExecutionTarget { agent, thisMac, isolatedBrowser }

extension TalkExecutionTargetPresentation on TalkExecutionTarget {
  String get label => switch (this) {
    TalkExecutionTarget.agent => 'Asael only',
    TalkExecutionTarget.thisMac => 'This Mac',
    TalkExecutionTarget.isolatedBrowser => 'Isolated browser',
  };

  String get detail => switch (this) {
    TalkExecutionTarget.agent => 'No computer control',
    TalkExecutionTarget.thisMac => 'Use this installed Mac',
    TalkExecutionTarget.isolatedBrowser => 'Use the remote private browser',
  };

  String? get apiValue => switch (this) {
    TalkExecutionTarget.agent => null,
    TalkExecutionTarget.thisMac => 'local_macos',
    TalkExecutionTarget.isolatedBrowser => 'isolated_browser',
  };

  IconData get icon => switch (this) {
    TalkExecutionTarget.agent => Icons.auto_awesome_outlined,
    TalkExecutionTarget.thisMac => Icons.laptop_mac_rounded,
    TalkExecutionTarget.isolatedBrowser => Icons.language_rounded,
  };
}

class TalkActivity {
  const TalkActivity({
    required this.key,
    required this.title,
    required this.detail,
    required this.state,
    this.actionLabel,
    this.actionRoute,
  });

  final String key;
  final String title;
  final String detail;
  final TalkActivityState state;
  final String? actionLabel;
  final String? actionRoute;
}

class TalkWorkflowSnapshot {
  const TalkWorkflowSnapshot({
    required this.id,
    required this.status,
    this.currentStep,
  });

  final String id;
  final String status;
  final String? currentStep;

  bool get terminal =>
      const {'completed', 'failed', 'canceled'}.contains(status);

  factory TalkWorkflowSnapshot.fromJson(Json payload) {
    final run = _jsonRecord(payload['run']);
    final id = _boundedDisplayText(run['id'], 200);
    final status = _boundedDisplayText(run['status'], 40).toLowerCase();
    if (id.isEmpty ||
        !const {
          'queued',
          'running',
          'waiting_approval',
          'paused',
          'completed',
          'failed',
          'canceled',
        }.contains(status)) {
      throw const FormatException('Invalid workflow status projection.');
    }
    final currentStep = _boundedDisplayText(run['currentStep'], 80);
    return TalkWorkflowSnapshot(
      id: id,
      status: status,
      currentStep: currentStep.isEmpty ? null : currentStep,
    );
  }
}

class TalkAgentIdentitySummary {
  const TalkAgentIdentitySummary({
    required this.state,
    this.name,
    this.role,
    this.definitionVersion,
  });

  final String state;
  final String? name;
  final String? role;
  final int? definitionVersion;
}

class TalkGroundingSummary {
  const TalkGroundingSummary({
    required this.status,
    required this.sourceCount,
    required this.citedCount,
    required this.invalidCitationCount,
    required this.contextEvidenceCount,
  });

  final String status;
  final int sourceCount;
  final int citedCount;
  final int invalidCitationCount;
  final int contextEvidenceCount;
}

class TalkMediaArtifactSummary {
  const TalkMediaArtifactSummary({
    required this.assetId,
    required this.kind,
    required this.operation,
    required this.filename,
    required this.mediaType,
    required this.byteCount,
    required this.status,
    this.sourceRunId,
    this.contextLabel,
  });

  final String assetId;
  final String kind;
  final String operation;
  final String filename;
  final String mediaType;
  final int byteCount;
  final String status;
  final String? sourceRunId;
  final String? contextLabel;
}

class TalkArtifactContent {
  const TalkArtifactContent({required this.assetId, required this.bytes});

  final String assetId;
  final Uint8List bytes;
}

class TalkQueuedPrompt {
  const TalkQueuedPrompt({
    required this.id,
    required this.input,
    required this.mode,
    required this.strategy,
    required this.executionTarget,
  });

  final String id;
  final String input;
  final String mode;
  final String strategy;
  final TalkExecutionTarget executionTarget;

  TalkQueuedPrompt copyWith({String? input}) => TalkQueuedPrompt(
    id: id,
    input: input ?? this.input,
    mode: mode,
    strategy: strategy,
    executionTarget: executionTarget,
  );
}

class TalkRunInspection {
  const TalkRunInspection({
    required this.runId,
    required this.status,
    required this.grounding,
    required this.agentIdentity,
    required this.mediaArtifacts,
    required this.computerUseArtifacts,
  });

  final String runId;
  final String status;
  final TalkGroundingSummary grounding;
  final TalkAgentIdentitySummary agentIdentity;
  final List<TalkMediaArtifactSummary> mediaArtifacts;
  final List<TalkMediaArtifactSummary> computerUseArtifacts;

  factory TalkRunInspection.fromJson(Json payload) {
    final run = _jsonRecord(payload['run']);
    final runId = _boundedDisplayText(run['id'], 200);
    final status = _boundedDisplayText(run['status'], 40).toLowerCase();
    if (runId.isEmpty || status.isEmpty) {
      throw const FormatException('Invalid run evidence projection.');
    }

    final grounding = _jsonRecord(run['grounding']);
    final groundingStatus = _boundedDisplayText(
      grounding['status'],
      40,
    ).toLowerCase();
    final sources = grounding['sources'] is List
        ? (grounding['sources'] as List).take(64).length
        : 0;
    final cited = grounding['citedIds'] is List
        ? (grounding['citedIds'] as List).take(64).length
        : 0;
    final invalid = grounding['invalidIds'] is List
        ? (grounding['invalidIds'] as List).take(64).length
        : 0;
    final contextReceipt = _jsonRecord(payload['contextReceipt']);
    final actualCount = _boundedCount(
      contextReceipt['actualCount'],
      fallback: contextReceipt['actualEvidenceIds'] is List
          ? (contextReceipt['actualEvidenceIds'] as List).take(24).length
          : 0,
      maximum: 24,
    );

    final identity = _jsonRecord(payload['agentIdentity']);
    final identityState = _boundedDisplayText(
      identity['state'],
      40,
    ).toLowerCase();
    final card = identityState == 'ready'
        ? _jsonRecord(identity['card'])
        : const <String, dynamic>{};
    final name = _boundedDisplayText(card['name'], 120);
    final role = _boundedDisplayText(card['role'], 120);
    final definitionVersion = _boundedCount(
      card['definitionVersion'],
      fallback: 0,
      maximum: 1000000,
    );

    final seenAssetIds = <String>{};
    final mediaArtifacts = <TalkMediaArtifactSummary>[];
    final rawArtifacts = payload['mediaArtifacts'];
    if (rawArtifacts is List) {
      for (final candidate in rawArtifacts.take(64)) {
        final artifact = _jsonRecord(candidate);
        final assetId = _boundedDisplayText(artifact['assetId'], 200);
        final kind = _boundedDisplayText(artifact['kind'], 20).toLowerCase();
        final operation = _boundedDisplayText(
          artifact['operation'],
          20,
        ).toLowerCase();
        final artifactStatus = _boundedDisplayText(
          artifact['status'],
          30,
        ).toLowerCase();
        final filename = _boundedDisplayText(artifact['filename'], 240);
        final mediaType = _boundedDisplayText(
          artifact['mediaType'],
          160,
        ).toLowerCase();
        final byteCount = _boundedCount(
          artifact['byteCount'],
          fallback: -1,
          maximum: 1024 * 1024 * 1024,
        );
        if (assetId.isEmpty ||
            !RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(assetId) ||
            !seenAssetIds.add(assetId) ||
            (kind != 'image' && kind != 'video') ||
            !const {'generate', 'edit', 'clip'}.contains(operation) ||
            (kind == 'image' && operation == 'clip') ||
            !const {
              'stored',
              'queued',
              'indexed',
              'unsupported',
              'failed',
            }.contains(artifactStatus) ||
            filename.isEmpty ||
            !mediaType.startsWith('$kind/') ||
            byteCount < 0) {
          continue;
        }
        mediaArtifacts.add(
          TalkMediaArtifactSummary(
            assetId: assetId,
            kind: kind,
            operation: operation,
            filename: filename,
            mediaType: mediaType,
            byteCount: byteCount,
            status: artifactStatus,
          ),
        );
      }
    }

    final computerUseArtifacts = <TalkMediaArtifactSummary>[];
    final rawComputerUseEvidence = payload['computerUseEvidence'];
    if (rawComputerUseEvidence is List) {
      for (final candidate in rawComputerUseEvidence.take(24)) {
        final evidence = _jsonRecord(candidate);
        final frame = _jsonRecord(evidence['frame']);
        final frameId = _boundedDisplayText(frame['id'], 200);
        final operation = _boundedDisplayText(
          evidence['operation'],
          80,
        ).toLowerCase();
        final action = _boundedDisplayText(evidence['action'], 120);
        final evidenceStatus = _boundedDisplayText(
          evidence['status'],
          30,
        ).toLowerCase();
        final filename = _boundedDisplayText(frame['filename'], 240);
        final mediaType = _boundedDisplayText(
          frame['mediaType'],
          160,
        ).toLowerCase();
        final byteCount = _boundedCount(
          frame['byteCount'],
          fallback: -1,
          maximum: 1500000,
        );
        final targetOrigin = _validatedWebOrigin(
          _boundedDisplayText(evidence['targetOrigin'], 500),
        );
        if (frameId.isEmpty ||
            !RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(frameId) ||
            !seenAssetIds.add(frameId) ||
            !RegExp(r'^browser_[a-z_]{1,80}$').hasMatch(operation) ||
            action.isEmpty ||
            !const {
              'executed',
              'dry_run',
              'failed',
              'blocked',
            }.contains(evidenceStatus) ||
            !RegExp(r'^computer-use-[0-9]{4}\.(png|jpg|webp)$')
                .hasMatch(filename) ||
            !const {
              'image/png',
              'image/jpeg',
              'image/webp',
            }.contains(mediaType) ||
            byteCount <= 0) {
          continue;
        }
        computerUseArtifacts.add(
          TalkMediaArtifactSummary(
            assetId: frameId,
            kind: 'computer',
            operation: operation,
            filename: filename,
            mediaType: mediaType,
            byteCount: byteCount,
            status: evidenceStatus == 'executed' ? 'stored' : evidenceStatus,
            sourceRunId: runId,
            contextLabel: targetOrigin == null
                ? action
                : '$action · $targetOrigin',
          ),
        );
      }
    }

    return TalkRunInspection(
      runId: runId,
      status: status,
      grounding: TalkGroundingSummary(
        status:
            const {
              'verified',
              'not_required',
              'missing',
              'invalid',
            }.contains(groundingStatus)
            ? groundingStatus
            : 'unavailable',
        sourceCount: sources,
        citedCount: cited,
        invalidCitationCount: invalid,
        contextEvidenceCount: actualCount,
      ),
      agentIdentity: TalkAgentIdentitySummary(
        state:
            const {
              'ready',
              'unbound',
              'definition_unavailable',
            }.contains(identityState)
            ? identityState
            : 'unavailable',
        name: name.isEmpty ? null : name,
        role: role.isEmpty ? null : role,
        definitionVersion: definitionVersion > 0 ? definitionVersion : null,
      ),
      mediaArtifacts: List.unmodifiable(mediaArtifacts),
      computerUseArtifacts: List.unmodifiable(computerUseArtifacts),
    );
  }
}

class TalkMessage {
  const TalkMessage({
    required this.role,
    required this.text,
    this.streaming = false,
    this.failed = false,
  });
  final TalkRole role;
  final String text;
  final bool streaming, failed;
  TalkMessage copyWith({String? text, bool? streaming, bool? failed}) =>
      TalkMessage(
        role: role,
        text: text ?? this.text,
        streaming: streaming ?? this.streaming,
        failed: failed ?? this.failed,
      );
}

abstract interface class TalkRepository {
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
  });
  Future<String> transcribeVoice(Uint8List bytes);
  Future<void> cancelRun(String runId);
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId);
  Future<TalkRunInspection> inspectRun(String runId);
}

abstract interface class TalkArtifactRepository {
  Future<TalkArtifactContent> loadArtifact(TalkMediaArtifactSummary artifact);
}

class TalkController extends ChangeNotifier with TalkHistoryControllerMixin {
  TalkController(
    this.repository, {
    this.workflowPollInterval = const Duration(seconds: 3),
    this.workflowPollLimit = 20,
  }) : assert(workflowPollLimit > 0 && workflowPollLimit <= 120);

  final TalkRepository repository;
  final Duration workflowPollInterval;
  final int workflowPollLimit;
  final messages = <TalkMessage>[];
  final activities = <TalkActivity>[];
  final artifacts = <TalkMediaArtifactSummary>[];
  final promptQueue = <TalkQueuedPrompt>[];
  final _workflowIds = <String>[];
  final _workflowMonitorTokens = <String, Object>{};
  final _inspectedRunIds = <String>{};
  String? runId;
  String? status;
  bool sending = false;
  bool canceling = false;
  bool transcribing = false;
  bool queuePaused = false;
  bool artifactLoading = false;
  Object? artifactError;
  TalkMediaArtifactSummary? selectedArtifact;
  TalkArtifactContent? selectedArtifactContent;
  Object? voiceError;
  bool _disposed = false;
  bool _drainingQueue = false;
  int _promptSequence = 0;

  List<String> get workflowIds => List.unmodifiable(_workflowIds);
  Set<String> get monitoringWorkflowIds =>
      Set.unmodifiable(_workflowMonitorTokens.keys);

  @override
  TalkHistoryRepository? get talkHistoryRepository =>
      repository is TalkHistoryRepository
      ? repository as TalkHistoryRepository
      : null;

  @override
  bool get historyInteractionBusy => sending;

  @override
  void applyHistoryThreadProjection(TalkThreadDetail detail) {
    messages.clear();
    messages.addAll(
      detail.turns.map(
        (turn) => TalkMessage(
          role: turn.role == TalkThreadRole.user
              ? TalkRole.user
              : TalkRole.assistant,
          text: turn.text,
        ),
      ),
    );
    activities.clear();
    _clearArtifacts();
    promptQueue.clear();
    queuePaused = false;
    _workflowIds.clear();
    _workflowMonitorTokens.clear();
    _retryInput = null;
    _retryMode = null;
    _retryStrategy = null;
    _retryExecutionTarget = null;
    runId = null;
    status = null;
    canceling = false;
  }

  @override
  void clearHistoryThreadProjection() {
    messages.clear();
    activities.clear();
    _clearArtifacts();
    promptQueue.clear();
    queuePaused = false;
    _workflowIds.clear();
    _workflowMonitorTokens.clear();
    _retryInput = null;
    _retryMode = null;
    _retryStrategy = null;
    _retryExecutionTarget = null;
    runId = null;
    status = null;
  }

  Future<void> send(
    String input, {
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
  }) async {
    final text = input.trim();
    if (text.isEmpty) return;
    if (sending) {
      enqueuePrompt(
        text,
        mode: mode,
        strategy: strategy,
        executionTarget: executionTarget,
      );
      return;
    }
    queuePaused = false;
    return _send(
      input,
      mode: mode,
      strategy: strategy,
      executionTarget: executionTarget,
    );
  }

  void enqueuePrompt(
    String input, {
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
  }) {
    final text = input.trim();
    if (text.isEmpty || text.length > 20000 || promptQueue.length >= 20) {
      return;
    }
    promptQueue.add(
      TalkQueuedPrompt(
        id: 'prompt-${DateTime.now().microsecondsSinceEpoch}-${_promptSequence++}',
        input: text,
        mode: mode,
        strategy: strategy,
        executionTarget: executionTarget,
      ),
    );
    notifyListeners();
  }

  void updateQueuedPrompt(String id, String input) {
    final text = input.trim();
    if (text.isEmpty || text.length > 20000) return;
    final index = promptQueue.indexWhere((item) => item.id == id);
    if (index < 0) return;
    promptQueue[index] = promptQueue[index].copyWith(input: text);
    notifyListeners();
  }

  void removeQueuedPrompt(String id) {
    promptQueue.removeWhere((item) => item.id == id);
    notifyListeners();
  }

  void moveQueuedPrompt(String id, int offset) {
    final index = promptQueue.indexWhere((item) => item.id == id);
    final next = index + offset;
    if (index < 0 || next < 0 || next >= promptQueue.length) return;
    final item = promptQueue.removeAt(index);
    promptQueue.insert(next, item);
    notifyListeners();
  }

  void pauseQueue() {
    if (queuePaused) return;
    queuePaused = true;
    notifyListeners();
  }

  void resumeQueue() {
    if (!queuePaused && (sending || promptQueue.isEmpty)) return;
    queuePaused = false;
    notifyListeners();
    unawaited(_drainPromptQueue());
  }

  Future<void> runQueuedPrompt(String id) async {
    final index = promptQueue.indexWhere((item) => item.id == id);
    if (index < 0) return;
    if (sending) {
      if (index > 0) {
        final item = promptQueue.removeAt(index);
        promptQueue.insert(0, item);
        notifyListeners();
      }
      return;
    }
    final item = promptQueue.removeAt(index);
    queuePaused = false;
    notifyListeners();
    await _send(
      item.input,
      mode: item.mode,
      strategy: item.strategy,
      executionTarget: item.executionTarget,
    );
  }

  Future<void> selectArtifact(TalkMediaArtifactSummary artifact) async {
    if (!artifacts.any((item) => item.assetId == artifact.assetId)) return;
    selectedArtifact = artifact;
    selectedArtifactContent = null;
    artifactError = null;
    final source = repository is TalkArtifactRepository
        ? repository as TalkArtifactRepository
        : null;
    if (source == null ||
        artifact.status == 'failed' ||
        artifact.status == 'unsupported') {
      artifactError = StateError(
        'A preview is not available for this artifact.',
      );
      notifyListeners();
      return;
    }
    artifactLoading = true;
    notifyListeners();
    try {
      final content = await source.loadArtifact(artifact);
      if (_disposed || selectedArtifact?.assetId != artifact.assetId) return;
      if (content.assetId != artifact.assetId || content.bytes.isEmpty) {
        throw const FormatException('The artifact preview did not match.');
      }
      selectedArtifactContent = content;
    } catch (error) {
      if (!_disposed && selectedArtifact?.assetId == artifact.assetId) {
        artifactError = error;
      }
    } finally {
      if (!_disposed && selectedArtifact?.assetId == artifact.assetId) {
        artifactLoading = false;
        notifyListeners();
      }
    }
  }

  void _clearArtifacts() {
    artifacts.clear();
    selectedArtifact = null;
    selectedArtifactContent = null;
    artifactError = null;
    artifactLoading = false;
  }

  String? _retryInput;
  String? _retryMode;
  String? _retryStrategy;
  TalkExecutionTarget? _retryExecutionTarget;

  bool get canRetry => !sending && _retryInput != null;

  Future<void> cancel() async {
    final id = runId;
    if (id == null || !sending || canceling) return;
    canceling = true;
    _recordActivity(
      key: 'cancel',
      title: 'Stopping run',
      detail: 'A governed cancellation request was sent.',
      state: TalkActivityState.active,
    );
    notifyListeners();
    try {
      await repository.cancelRun(id);
      _recordActivity(
        key: 'cancel',
        title: 'Stop requested',
        detail: 'Waiting for the run to confirm its terminal state.',
        state: TalkActivityState.waiting,
      );
    } catch (_) {
      _recordActivity(
        key: 'cancel',
        title: 'Stop request failed',
        detail: 'The run may still be active. Try again from Results.',
        state: TalkActivityState.failed,
      );
    } finally {
      canceling = false;
      notifyListeners();
    }
  }

  Future<void> retryLast() async {
    final input = _retryInput;
    if (input == null || sending) return;
    await _send(
      input,
      mode: _retryMode ?? 'orchestrate',
      strategy: _retryStrategy ?? 'auto',
      executionTarget: _retryExecutionTarget ?? TalkExecutionTarget.agent,
      replaceFailedResponse: true,
    );
  }

  Future<String?> transcribeVoice(Uint8List bytes) async {
    if (transcribing || bytes.isEmpty || bytes.length > 10 * 1024 * 1024) {
      return null;
    }
    transcribing = true;
    voiceError = null;
    status = 'Transcribing voice draft';
    notifyListeners();
    try {
      return await repository.transcribeVoice(bytes);
    } catch (error) {
      voiceError = error;
      return null;
    } finally {
      transcribing = false;
      status = null;
      notifyListeners();
    }
  }

  Future<void> _send(
    String input, {
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    bool replaceFailedResponse = false,
  }) async {
    final text = input.trim();
    if (text.isEmpty || sending) return;
    activities.clear();
    runId = null;
    if (replaceFailedResponse && messages.lastOrNull?.failed == true) {
      messages[messages.length - 1] = const TalkMessage(
        role: TalkRole.assistant,
        text: '',
        streaming: true,
      );
    } else {
      messages.add(TalkMessage(role: TalkRole.user, text: text));
      messages.add(
        const TalkMessage(role: TalkRole.assistant, text: '', streaming: true),
      );
    }
    sending = true;
    status = 'Connecting';
    notifyListeners();
    String? terminalInspectionRunId;
    try {
      await for (final event in repository.send(
        message: text,
        threadId: threadId,
        mode: mode,
        strategy: strategy,
        executionTarget: executionTarget,
      )) {
        adoptConversationThreadId(event.data['threadId']);
        switch (event.event) {
          case 'run':
            runId = event.data['runId'] as String?;
            _recordActivity(
              key: 'run',
              title: 'Main agent',
              detail: 'Started a governed run.',
              state: TalkActivityState.active,
            );
          case 'delta':
            messages[messages.length - 1] = messages.last.copyWith(
              text: messages.last.text + (event.data['text'] as String? ?? ''),
            );
          case 'status':
            status = event.data['label'] as String? ?? 'Working';
            _recordActivity(
              key: 'status',
              title: _sentenceCase(status!),
              detail: event.data['detail'] as String? ?? 'Work is in progress.',
              state: TalkActivityState.active,
            );
          case 'harness':
            final provider = event.data['provider']?.toString() ?? 'configured';
            final model = event.data['model']?.toString() ?? 'model';
            final toolCount = event.data['toolCount'] as int? ?? 0;
            final skills = event.data['skillIds'] is List
                ? (event.data['skillIds'] as List).length
                : 0;
            _recordActivity(
              key: 'harness',
              title: 'Run context prepared',
              detail: '$provider · $model · $toolCount tools · $skills skills',
              state: TalkActivityState.succeeded,
            );
          case 'memory':
            _recordActivity(
              key: 'memory:${event.data['title']}',
              title: event.data['title'] as String? ?? 'Memory updated',
              detail: _countDetail(event.data['count'], 'memory item'),
              state: TalkActivityState.succeeded,
            );
          case 'model':
            final provider = event.data['provider']?.toString() ?? 'provider';
            final model = event.data['model']?.toString() ?? 'model';
            final tokens = event.data['totalTokens'] as int? ?? 0;
            final latency = event.data['latencyMs'] as int? ?? 0;
            _recordActivity(
              key: 'model:${event.data['iteration'] ?? activities.length}',
              title: 'Model response',
              detail: '$provider · $model · $tokens tokens · ${latency}ms',
              state: TalkActivityState.succeeded,
            );
          case 'council_member':
            final agentName =
                event.data['agentName'] as String? ?? 'Specialist agent';
            final lifecycle = event.data['lifecycleState']?.toString();
            final memberStatus = event.data['status']?.toString() ?? 'thinking';
            _recordActivity(
              key:
                  'agent:${event.data['taskId'] ?? event.data['delegationId'] ?? event.data['agentId'] ?? agentName}',
              title: agentName,
              detail:
                  event.data['summary'] as String? ??
                  event.data['role'] as String? ??
                  'Specialist work',
              state: _agentActivityState(lifecycle ?? memberStatus),
            );
          case 'council_verdict':
            final verdict = event.data['status']?.toString() ?? 'completed';
            _recordActivity(
              key: 'council-verdict',
              title: 'Council review',
              detail:
                  event.data['assessment'] as String? ??
                  'Independent review $verdict.',
              state: verdict == 'failed'
                  ? TalkActivityState.failed
                  : TalkActivityState.succeeded,
            );
          case 'tool':
            final toolStatus = event.data['status']?.toString() ?? 'running';
            final toolName =
                event.data['toolName'] as String? ??
                event.data['toolId'] as String? ??
                'Tool';
            _recordActivity(
              key:
                  'tool:${event.data['executionId'] ?? event.data['toolId'] ?? toolName}',
              title: toolName,
              detail:
                  event.data['summary'] as String? ??
                  _sentenceCase(toolStatus.replaceAll('_', ' ')),
              state: _toolActivityState(toolStatus),
            );
          case 'clarification':
            queuePaused = true;
            final message =
                event.data['message'] as String? ??
                'Asael needs one detail before continuing.';
            messages[messages.length - 1] = messages.last.copyWith(
              text: message,
              streaming: false,
            );
            status = 'Needs your input';
            _recordActivity(
              key: 'clarification',
              title: 'Clarification needed',
              detail: message,
              state: TalkActivityState.waiting,
            );
          case 'delegated':
            final delegatedWorkflowId = _boundedDisplayText(
              event.data['workflowId'],
              200,
            );
            if (delegatedWorkflowId.isNotEmpty) {
              _rememberWorkflow(delegatedWorkflowId);
              _startWorkflowMonitor(delegatedWorkflowId);
            }
            messages[messages.length - 1] = messages.last.copyWith(
              text:
                  event.data['acknowledgement'] as String? ??
                  'Moved to a durable mission.',
              streaming: false,
            );
            status = 'Delegated';
            _recordActivity(
              key: delegatedWorkflowId.isEmpty
                  ? 'delegated'
                  : 'workflow:$delegatedWorkflowId',
              title: 'Background work started',
              detail:
                  event.data['reason'] as String? ??
                  'The run will continue durably.',
              state: TalkActivityState.active,
              actionLabel: delegatedWorkflowId.isEmpty ? null : 'Open workflow',
              actionRoute: delegatedWorkflowId.isEmpty
                  ? null
                  : _resultRoute('workflow', delegatedWorkflowId),
            );
          case 'done':
            terminalInspectionRunId = runId;
            messages[messages.length - 1] = messages.last.copyWith(
              text: event.data['response'] as String? ?? messages.last.text,
              streaming: false,
            );
            status = null;
            _recordActivity(
              key: 'run',
              title: 'Main agent',
              detail: 'Response completed.',
              state: TalkActivityState.succeeded,
            );
            _recordActivity(
              key: 'status',
              title: 'Response ready',
              detail: 'The governed run reached a terminal response.',
              state: TalkActivityState.succeeded,
            );
          case 'waiting_approval':
            queuePaused = true;
            status = 'Waiting for approval';
            final message =
                event.data['message'] as String? ??
                'Review the requested action before it continues.';
            if (messages.last.text.isEmpty) {
              messages[messages.length - 1] = messages.last.copyWith(
                text: message,
                streaming: false,
              );
            }
            _recordActivity(
              key: 'approval:${event.data['executionId'] ?? 'pending'}',
              title: 'Approval required',
              detail: message,
              state: TalkActivityState.waiting,
              actionLabel: 'Review approval',
              actionRoute: event.data['executionId'] is String
                  ? '/inbox/approvals/${Uri.encodeComponent(event.data['executionId'] as String)}'
                  : '/inbox',
            );
          case 'budget_exhausted':
            queuePaused = true;
            final message =
                event.data['message'] as String? ??
                'This run reached its authorized budget.';
            messages[messages.length - 1] = messages.last.copyWith(
              text: message,
              streaming: false,
            );
            status = 'Authorization required';
            _recordActivity(
              key: 'budget',
              title: 'Run budget reached',
              detail: message,
              state: TalkActivityState.waiting,
            );
          case 'canceled':
            terminalInspectionRunId = runId;
            final message =
                event.data['message'] as String? ?? 'The run was canceled.';
            messages[messages.length - 1] = messages.last.copyWith(
              text: message,
              streaming: false,
            );
            status = null;
            _recordActivity(
              key: 'run',
              title: 'Main agent',
              detail: message,
              state: TalkActivityState.failed,
            );
          case 'error':
            terminalInspectionRunId = runId;
            throw StateError(
              event.data['message'] as String? ?? 'Agent failed',
            );
        }
        notifyListeners();
      }
      _retryInput = null;
      _retryMode = null;
      _retryStrategy = null;
      _retryExecutionTarget = null;
    } catch (error) {
      final failure = _talkFailure(error);
      queuePaused = true;
      messages[messages.length - 1] = messages.last.copyWith(
        text: messages.last.text.isEmpty ? failure.message : messages.last.text,
        streaming: false,
        failed: true,
      );
      _retryInput = text;
      _retryMode = mode;
      _retryStrategy = strategy;
      _retryExecutionTarget = executionTarget;
      _recordActivity(
        key: 'run',
        title: 'Main agent',
        detail: failure.detail,
        state: TalkActivityState.failed,
      );
    } finally {
      sending = false;
      status = null;
      notifyListeners();
    }
    if (terminalInspectionRunId case final id?) {
      await _inspectTerminalRun(id);
    }
    if (conversationHistorySupported && !_disposed) {
      unawaited(loadRecentThreads(force: true));
    }
    if (!_disposed) unawaited(_drainPromptQueue());
  }

  Future<void> _drainPromptQueue() async {
    if (_drainingQueue || sending || queuePaused || promptQueue.isEmpty) return;
    _drainingQueue = true;
    try {
      while (!_disposed && !sending && !queuePaused && promptQueue.isNotEmpty) {
        final next = promptQueue.removeAt(0);
        notifyListeners();
        await _send(
          next.input,
          mode: next.mode,
          strategy: next.strategy,
          executionTarget: next.executionTarget,
        );
      }
    } finally {
      _drainingQueue = false;
    }
  }

  void _rememberWorkflow(String workflowId) {
    _workflowIds.remove(workflowId);
    _workflowIds.add(workflowId);
    if (_workflowIds.length > 12) _workflowIds.removeAt(0);
  }

  void _startWorkflowMonitor(String workflowId) {
    if (_disposed || _workflowMonitorTokens.containsKey(workflowId)) return;
    final token = Object();
    _workflowMonitorTokens[workflowId] = token;
    unawaited(_monitorWorkflow(workflowId, token));
  }

  Future<void> _monitorWorkflow(String workflowId, Object token) async {
    var receivedProjection = false;
    for (var attempt = 0; attempt < workflowPollLimit; attempt += 1) {
      if (attempt > 0 && workflowPollInterval > Duration.zero) {
        await Future<void>.delayed(workflowPollInterval);
      }
      if (!_monitorIsCurrent(workflowId, token)) return;
      try {
        final snapshot = await repository.inspectWorkflow(workflowId);
        if (!_monitorIsCurrent(workflowId, token)) return;
        if (snapshot.id != workflowId) {
          throw const FormatException('Workflow identity did not match.');
        }
        receivedProjection = true;
        _projectWorkflowActivity(snapshot);
        if (!_disposed) notifyListeners();
        if (snapshot.terminal) {
          _workflowMonitorTokens.remove(workflowId);
          return;
        }
      } catch (_) {
        if (!_monitorIsCurrent(workflowId, token)) return;
        _recordActivity(
          key: 'workflow:$workflowId',
          title: receivedProjection
              ? 'Background work continues'
              : 'Connecting to background work',
          detail: 'The next bounded status check will retry automatically.',
          state: TalkActivityState.active,
          actionLabel: 'Open workflow',
          actionRoute: _resultRoute('workflow', workflowId),
        );
        if (!_disposed) notifyListeners();
      }
    }
    if (!_monitorIsCurrent(workflowId, token)) return;
    _workflowMonitorTokens.remove(workflowId);
    _recordActivity(
      key: 'workflow:$workflowId',
      title: 'Background work still running',
      detail:
          'Live checks paused after $workflowPollLimit updates. Open the workflow for its current state.',
      state: TalkActivityState.waiting,
      actionLabel: 'Open workflow',
      actionRoute: _resultRoute('workflow', workflowId),
    );
    if (!_disposed) notifyListeners();
  }

  bool _monitorIsCurrent(String workflowId, Object token) =>
      !_disposed && identical(_workflowMonitorTokens[workflowId], token);

  void _projectWorkflowActivity(TalkWorkflowSnapshot workflow) {
    final step = workflow.currentStep == null
        ? ''
        : ' · ${_sentenceCase(workflow.currentStep!.replaceAll('_', ' '))}';
    final (title, detail, state) = switch (workflow.status) {
      'queued' => (
        'Background work queued',
        'Waiting for durable execution to begin.',
        TalkActivityState.active,
      ),
      'running' => (
        'Background work in progress',
        'Running$step.',
        TalkActivityState.active,
      ),
      'waiting_approval' => (
        'Background work needs approval',
        'A governed action is waiting for operator review$step.',
        TalkActivityState.waiting,
      ),
      'paused' => (
        'Background work paused',
        'The durable workflow is paused$step.',
        TalkActivityState.waiting,
      ),
      'completed' => (
        'Background work complete',
        'The durable workflow completed successfully.',
        TalkActivityState.succeeded,
      ),
      'failed' => (
        'Background work failed',
        'The workflow ended without a verified completion.',
        TalkActivityState.failed,
      ),
      _ => (
        'Background work canceled',
        'The durable workflow was canceled.',
        TalkActivityState.failed,
      ),
    };
    _recordActivity(
      key: 'workflow:${workflow.id}',
      title: title,
      detail: detail,
      state: state,
      actionLabel: 'Open workflow',
      actionRoute: _resultRoute('workflow', workflow.id),
    );
  }

  Future<void> _inspectTerminalRun(String id) async {
    if (_disposed || !_inspectedRunIds.add(id)) return;
    final route = _resultRoute('agent', id);
    try {
      final inspection = await repository.inspectRun(id);
      if (_disposed) return;
      if (inspection.runId != id) {
        throw const FormatException('Run identity did not match.');
      }
      _projectAgentIdentity(inspection, route);
      _projectGrounding(inspection, route);
      _projectMediaArtifacts(inspection, route);
      _projectComputerUseArtifacts(inspection, route);
      artifacts
        ..clear()
        ..addAll(inspection.mediaArtifacts)
        ..addAll(inspection.computerUseArtifacts);
      if (artifacts.isEmpty) {
        selectedArtifact = null;
        selectedArtifactContent = null;
        artifactError = null;
      } else {
        unawaited(selectArtifact(artifacts.first));
      }
    } catch (_) {
      if (_disposed) return;
      _recordActivity(
        key: 'evidence:$id',
        title: 'Run evidence available in Results',
        detail: 'The compact evidence summary could not refresh.',
        state: TalkActivityState.info,
        actionLabel: 'Open result',
        actionRoute: route,
      );
    }
    if (!_disposed) notifyListeners();
  }

  void _projectAgentIdentity(TalkRunInspection inspection, String route) {
    final identity = inspection.agentIdentity;
    if (identity.state == 'ready' && identity.name != null) {
      final version = identity.definitionVersion == null
          ? ''
          : ' · definition v${identity.definitionVersion}';
      _recordActivity(
        key: 'identity:${inspection.runId}',
        title: identity.name!,
        detail: '${identity.role ?? 'Agent'}$version',
        state: TalkActivityState.info,
        actionLabel: 'Open result',
        actionRoute: route,
      );
      return;
    }
    _recordActivity(
      key: 'identity:${inspection.runId}',
      title: 'Agent identity unavailable',
      detail: identity.state == 'unbound'
          ? 'This legacy run predates pinned agent identity.'
          : 'The historical definition could not be projected.',
      state: TalkActivityState.info,
      actionLabel: 'Open result',
      actionRoute: route,
    );
  }

  void _projectGrounding(TalkRunInspection inspection, String route) {
    final grounding = inspection.grounding;
    final counts = <String>[
      '${grounding.sourceCount} source${grounding.sourceCount == 1 ? '' : 's'}',
      '${grounding.citedCount} cited',
      if (grounding.contextEvidenceCount > 0)
        '${grounding.contextEvidenceCount} context items used',
      if (grounding.invalidCitationCount > 0)
        '${grounding.invalidCitationCount} invalid',
    ].join(' · ');
    final (title, state) = switch (grounding.status) {
      'verified' => ('Evidence verified', TalkActivityState.succeeded),
      'not_required' => (
        'No retrieved evidence required',
        TalkActivityState.succeeded,
      ),
      'missing' => ('Evidence review needed', TalkActivityState.waiting),
      'invalid' => ('Evidence validation failed', TalkActivityState.failed),
      _ => ('Grounding unavailable', TalkActivityState.info),
    };
    _recordActivity(
      key: 'evidence:${inspection.runId}',
      title: title,
      detail: counts,
      state: state,
      actionLabel: 'Open result',
      actionRoute: route,
    );
  }

  void _projectMediaArtifacts(TalkRunInspection inspection, String route) {
    for (final artifact in inspection.mediaArtifacts.take(8)) {
      final operation = _sentenceCase(artifact.operation);
      final kind = artifact.kind == 'image' ? 'Image' : 'Video';
      _recordActivity(
        key: 'media:${artifact.assetId}',
        title: '$kind $operation'.trim(),
        detail:
            '${artifact.filename} · ${artifact.mediaType} · ${_humanBytes(artifact.byteCount)}',
        state: artifact.status == 'failed' || artifact.status == 'unsupported'
            ? TalkActivityState.failed
            : artifact.status == 'queued'
            ? TalkActivityState.active
            : TalkActivityState.succeeded,
        actionLabel: 'Open result',
        actionRoute: route,
      );
    }
    final remaining = inspection.mediaArtifacts.length - 8;
    if (remaining > 0) {
      _recordActivity(
        key: 'media-more:${inspection.runId}',
        title: '$remaining more media artifacts',
        detail: 'Open the result to inspect the complete bounded projection.',
        state: TalkActivityState.info,
        actionLabel: 'Open result',
        actionRoute: route,
      );
    }
  }

  void _projectComputerUseArtifacts(
    TalkRunInspection inspection,
    String route,
  ) {
    if (inspection.computerUseArtifacts.isEmpty) return;
    _recordActivity(
      key: 'computer-evidence:${inspection.runId}',
      title: 'Computer Use evidence captured',
      detail:
          '${inspection.computerUseArtifacts.length} private visual checkpoint${inspection.computerUseArtifacts.length == 1 ? '' : 's'} available in Artifacts.',
      state: TalkActivityState.succeeded,
      actionLabel: 'Open result',
      actionRoute: route,
    );
  }

  static String _resultRoute(String kind, String id) =>
      '/results/${Uri.encodeComponent('$kind:$id')}';

  static String _humanBytes(int value) {
    if (value < 1024) return '$value B';
    if (value < 1024 * 1024) return '${(value / 1024).toStringAsFixed(1)} KB';
    return '${(value / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  void _recordActivity({
    required String key,
    required String title,
    required String detail,
    required TalkActivityState state,
    String? actionLabel,
    String? actionRoute,
  }) {
    final activity = TalkActivity(
      key: key,
      title: title,
      detail: detail,
      state: state,
      actionLabel: actionLabel,
      actionRoute: actionRoute,
    );
    final existing = activities.indexWhere((item) => item.key == key);
    if (existing >= 0) {
      activities[existing] = activity;
    } else {
      activities.add(activity);
      if (activities.length > 40) activities.removeAt(0);
    }
  }

  static TalkActivityState _agentActivityState(String value) => switch (value) {
    'completed' ||
    'completed_proposed' ||
    'result_accepted' => TalkActivityState.succeeded,
    'failed' ||
    'rejected' ||
    'canceled' ||
    'expired' => TalkActivityState.failed,
    'waiting' || 'challenged' => TalkActivityState.waiting,
    _ => TalkActivityState.active,
  };

  static TalkActivityState _toolActivityState(String value) => switch (value) {
    'executed' || 'dry_run' => TalkActivityState.succeeded,
    'approval_required' => TalkActivityState.waiting,
    'blocked' || 'failed' => TalkActivityState.failed,
    _ => TalkActivityState.active,
  };

  static String _sentenceCase(String value) {
    final text = value.trim();
    if (text.isEmpty) return text;
    return '${text[0].toUpperCase()}${text.substring(1)}';
  }

  static String _countDetail(Object? value, String label) {
    final count = value is int ? value : 1;
    return '$count $label${count == 1 ? '' : 's'}';
  }

  @override
  void dispose() {
    _disposed = true;
    disposeTalkHistory();
    _workflowMonitorTokens.clear();
    super.dispose();
  }
}

abstract interface class VoiceDraftRecorder {
  Future<bool> hasPermission();
  Future<void> start(String outputPath);
  Future<String?> stop();
  Future<void> cancel();
  Future<void> dispose();
}

class RecordVoiceDraftRecorder implements VoiceDraftRecorder {
  RecordVoiceDraftRecorder() : _recorder = AudioRecorder();

  final AudioRecorder _recorder;

  @override
  Future<bool> hasPermission() => _recorder.hasPermission();

  @override
  Future<void> start(String outputPath) => _recorder.start(
    const RecordConfig(
      encoder: AudioEncoder.aacLc,
      bitRate: 64000,
      sampleRate: 24000,
      numChannels: 1,
    ),
    path: outputPath,
  );

  @override
  Future<String?> stop() => _recorder.stop();

  @override
  Future<void> cancel() => _recorder.cancel();

  @override
  Future<void> dispose() => _recorder.dispose();
}

class TalkView extends StatefulWidget {
  const TalkView({
    super.key,
    required this.controller,
    this.voiceRecorder,
    this.quickEntry = false,
    this.onQuickEntryReady,
    this.onExitQuickEntry,
    this.localComputer,
  });

  final TalkController controller;
  final VoiceDraftRecorder? voiceRecorder;
  final bool quickEntry;
  final VoidCallback? onQuickEntryReady;
  final VoidCallback? onExitQuickEntry;
  final LocalComputerCoordinator? localComputer;
  @override
  State<TalkView> createState() => _TalkViewState();
}

class _TalkViewState extends State<TalkView> with WidgetsBindingObserver {
  final input = TextEditingController();
  final inputFocus = FocusNode(debugLabel: 'Asael command composer');
  final scroll = ScrollController();
  late final VoiceDraftRecorder recorder;
  String strategy = 'auto';
  TalkExecutionTarget executionTarget = TalkExecutionTarget.agent;
  bool recording = false;
  String? recordingError;
  int voiceDraftGeneration = 0;

  @override
  void initState() {
    super.initState();
    recorder = widget.voiceRecorder ?? RecordVoiceDraftRecorder();
    WidgetsBinding.instance.addObserver(this);
    if (widget.quickEntry) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.onQuickEntryReady?.call();
      });
    } else if (widget.controller.conversationHistorySupported) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(widget.controller.loadRecentThreads());
      });
    }
  }

  @override
  void didUpdateWidget(covariant TalkView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.quickEntry && !oldWidget.quickEntry) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.onQuickEntryReady?.call();
      });
    } else if (!widget.quickEntry &&
        oldWidget.controller != widget.controller &&
        widget.controller.conversationHistorySupported) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(widget.controller.loadRecentThreads());
      });
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      unawaited(interruptVoiceDraft());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    voiceDraftGeneration += 1;
    input.dispose();
    inputFocus.dispose();
    scroll.dispose();
    unawaited(_disposeRecorder());
    super.dispose();
  }

  Future<void> _disposeRecorder() async {
    try {
      await recorder.cancel();
    } catch (_) {
      // The platform may already have ended the interrupted recording.
    }
    try {
      await recorder.dispose();
    } catch (_) {
      // Disposal must not surface after the owning widget has gone away.
    }
  }

  Future<void> interruptVoiceDraft() async {
    voiceDraftGeneration += 1;
    if (mounted && recording) setState(() => recording = false);
    try {
      await recorder.cancel();
    } catch (_) {
      // Lifecycle interruption is fail-closed even if the OS ended first.
    }
  }

  void submit() {
    final value = input.text.trim();
    if (value.isEmpty) return;
    input.clear();
    final work = widget.controller.send(
      value,
      mode: 'orchestrate',
      strategy: strategy,
      executionTarget: executionTarget,
    );
    if (widget.quickEntry) widget.onExitQuickEntry?.call();
    unawaited(work);
  }

  Future<void> toggleVoiceDraft() async {
    if (widget.controller.transcribing || widget.controller.sending) return;
    setState(() => recordingError = null);
    if (recording) {
      final generation = voiceDraftGeneration;
      setState(() => recording = false);
      try {
        final path = await recorder.stop();
        if (path == null) throw StateError('Voice recording was not saved.');
        final file = File(path);
        final bytes = await file.readAsBytes();
        try {
          await file.delete();
        } catch (_) {
          // The OS may have already cleared the temporary recording.
        }
        final transcript = await widget.controller.transcribeVoice(bytes);
        if (!mounted ||
            generation != voiceDraftGeneration ||
            transcript == null ||
            transcript.trim().isEmpty) {
          return;
        }
        final existing = input.text.trim();
        input.text = existing.isEmpty
            ? transcript.trim()
            : '$existing\n${transcript.trim()}';
        input.selection = TextSelection.collapsed(offset: input.text.length);
      } catch (_) {
        if (mounted && generation == voiceDraftGeneration) {
          setState(() {
            recordingError = 'Voice draft could not be transcribed. Your typed draft is unchanged.';
          });
        }
      }
      return;
    }

    final generation = ++voiceDraftGeneration;
    try {
      if (!await recorder.hasPermission()) {
        throw StateError('Microphone permission was not granted.');
      }
      if (!mounted || generation != voiceDraftGeneration) return;
      final path =
          '${Directory.systemTemp.path}/asael-voice-${DateTime.now().microsecondsSinceEpoch}.m4a';
      await recorder.start(path);
      if (!mounted || generation != voiceDraftGeneration) {
        await recorder.cancel();
        return;
      }
      setState(() => recording = true);
    } catch (_) {
      if (mounted && generation == voiceDraftGeneration) {
        setState(() {
          recordingError =
              'Microphone access is required to create a voice draft.';
        });
      }
    }
  }

  Future<void> _openHistorySheet() async {
    await showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      builder: (sheetContext) => FractionallySizedBox(
        heightFactor: .82,
        child: ListenableBuilder(
          listenable: widget.controller,
          builder: (_, _) => TalkHistoryPane(
            controller: widget.controller,
            onNew: () {
              Navigator.of(sheetContext).pop();
              widget.controller.newConversation();
              inputFocus.requestFocus();
            },
            onSelected: (id) {
              Navigator.of(sheetContext).pop();
              unawaited(widget.controller.openThread(id));
            },
          ),
        ),
      ),
    );
  }

  Widget _buildQuickEntry(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: scheme.surface,
      body: CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.escape): () =>
              widget.onExitQuickEntry?.call(),
        },
        child: SafeArea(
          child: ListenableBuilder(
            listenable: widget.controller,
            builder: (context, _) => Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(14),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 760),
                  child: Material(
                    color: scheme.surfaceContainerLow,
                    elevation: 10,
                    shadowColor: Colors.black.withValues(alpha: .16),
                    borderRadius: BorderRadius.circular(22),
                    clipBehavior: Clip.antiAlias,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(18, 14, 14, 14),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Row(
                            children: [
                              const AsaelMark(size: 30),
                              const SizedBox(width: 10),
                              const Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      'Quick Entry',
                                      style: TextStyle(
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                                    Text(
                                      'Start governed work from anywhere',
                                      style: TextStyle(fontSize: 11.5),
                                    ),
                                  ],
                                ),
                              ),
                              if (widget.controller.sending)
                                const Padding(
                                  padding: EdgeInsets.only(right: 8),
                                  child: SizedBox.square(
                                    dimension: 16,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  ),
                                ),
                              IconButton(
                                tooltip: 'Close Quick Entry (Esc)',
                                onPressed: widget.onExitQuickEntry,
                                icon: const Icon(Icons.close_rounded),
                              ),
                            ],
                          ),
                          const SizedBox(height: 10),
                          Align(
                            alignment: Alignment.centerLeft,
                            child: _ExecutionTargetMenu(
                              value: executionTarget,
                              compact: true,
                              localComputer: widget.localComputer,
                              onChanged: (value) =>
                                  setState(() => executionTarget = value),
                            ),
                          ),
                          const SizedBox(height: 9),
                          TextField(
                            key: const ValueKey('quick-entry-input'),
                            controller: input,
                            focusNode: inputFocus,
                            autofocus: true,
                            minLines: 1,
                            maxLines: 4,
                            textInputAction: TextInputAction.send,
                            onSubmitted: (_) => submit(),
                            decoration: InputDecoration(
                              hintText: 'What needs to move?',
                              filled: true,
                              suffixIcon: IconButton(
                                tooltip: widget.controller.sending
                                    ? 'Add to prompt queue'
                                    : 'Send and open Conversation',
                                onPressed: submit,
                                icon: Icon(
                                  widget.controller.sending
                                      ? Icons.playlist_add_rounded
                                      : Icons.arrow_upward_rounded,
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(height: 9),
                          Row(
                            children: [
                              Icon(
                                Icons.shield_outlined,
                                size: 14,
                                color: scheme.onSurfaceVariant,
                              ),
                              const SizedBox(width: 6),
                              Expanded(
                                child: Text(
                                  widget.controller.status ??
                                      '${executionTarget.label} · governed · Esc to close',
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    color: scheme.onSurfaceVariant,
                                    fontSize: 11,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (widget.quickEntry) return _buildQuickEntry(context);
    return Scaffold(
      appBar: AppBar(
        title: ListenableBuilder(
          listenable: widget.controller,
          builder: (_, _) => Text(
            widget.controller.selectedThread?.title ?? 'Conversation',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        actions: [
          if (appDesktopHostBridge.supported)
            IconButton(
              tooltip: 'Open a new Conversation window',
              onPressed: () =>
                  appDesktopHostBridge.openWorkspaceWindow('/talk'),
              icon: const Icon(Icons.open_in_new_rounded),
            ),
          if (widget.controller.conversationHistorySupported)
            IconButton(
              tooltip: 'Conversation history',
              onPressed: _openHistorySheet,
              icon: const Icon(Icons.history_rounded),
            ),
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Center(
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surfaceContainerHigh,
                  borderRadius: BorderRadius.circular(99),
                ),
                child: const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.shield_outlined, size: 15),
                    SizedBox(width: 5),
                    Text('Governed'),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
      body: ListenableBuilder(
        listenable: widget.controller,
        builder: (_, _) => LayoutBuilder(
          builder: (context, constraints) {
            final conversation = Column(
              children: [
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 180),
                  child: widget.controller.status != null
                      ? Container(
                          key: ValueKey(widget.controller.status),
                          width: double.infinity,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 18,
                            vertical: 9,
                          ),
                          color: Theme.of(context)
                              .colorScheme
                              .surfaceContainerLow,
                          child: Row(
                            children: [
                              const SizedBox.square(
                                dimension: 14,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              ),
                              const SizedBox(width: 10),
                              Text(
                                widget.controller.status!,
                                style: Theme.of(context).textTheme.labelLarge,
                              ),
                            ],
                          ),
                        )
                      : const SizedBox.shrink(key: ValueKey('idle')),
                ),
                TalkThreadProjectionBanner(controller: widget.controller),
                Expanded(
                  child: widget.controller.messages.isEmpty
                      ? _TalkEmpty(
                          selectedThread: widget.controller.hasSelectedThread,
                          loading:
                              widget.controller.threadState ==
                              TalkThreadState.loading,
                        )
                      : ListView.builder(
                          controller: scroll,
                          padding: const EdgeInsets.all(16),
                          itemCount: widget.controller.messages.length,
                          itemBuilder: (_, i) {
                            final m = widget.controller.messages[i];
                            return Align(
                              alignment: m.role == TalkRole.user
                                  ? Alignment.centerRight
                                  : Alignment.centerLeft,
                              child: Container(
                                constraints: const BoxConstraints(
                                  maxWidth: 680,
                                ),
                                margin: const EdgeInsets.only(bottom: 14),
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                  vertical: 14,
                                ),
                                decoration: BoxDecoration(
                                  color: m.role == TalkRole.user
                                      ? Theme.of(context)
                                            .colorScheme
                                            .primaryContainer
                                      : Theme.of(context)
                                            .colorScheme
                                            .surfaceContainerHigh,
                                  borderRadius: BorderRadius.only(
                                    topLeft: const Radius.circular(20),
                                    topRight: const Radius.circular(20),
                                    bottomLeft: Radius.circular(
                                      m.role == TalkRole.user ? 20 : 6,
                                    ),
                                    bottomRight: Radius.circular(
                                      m.role == TalkRole.user ? 6 : 20,
                                    ),
                                  ),
                                  border: m.failed
                                      ? Border.all(
                                          color: Theme.of(context)
                                              .colorScheme
                                              .error,
                                        )
                                      : null,
                                ),
                                child: m.streaming && m.text.isEmpty
                                    ? const SizedBox.square(
                                        dimension: 18,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                        ),
                                      )
                                    : Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          SelectableText(m.text),
                                          if (m.failed &&
                                              i ==
                                                  widget
                                                          .controller
                                                          .messages
                                                          .length -
                                                      1) ...[
                                            const SizedBox(height: 8),
                                            TextButton.icon(
                                              onPressed:
                                                  widget.controller.canRetry
                                                  ? widget.controller.retryLast
                                                  : null,
                                              icon: const Icon(
                                                Icons.refresh_rounded,
                                              ),
                                              label: const Text('Retry'),
                                            ),
                                          ],
                                        ],
                                      ),
                              ),
                            );
                          },
                        ),
                ),
                SafeArea(
                  top: false,
                  child: Container(
                    margin: const EdgeInsets.fromLTRB(10, 0, 10, 8),
                    padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.surface,
                      borderRadius: BorderRadius.circular(24),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withValues(alpha: .07),
                          blurRadius: 24,
                          offset: const Offset(0, 8),
                        ),
                      ],
                    ),
                    child: Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 820),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Align(
                              alignment: Alignment.centerLeft,
                              child: Wrap(
                                spacing: 10,
                                runSpacing: 8,
                                crossAxisAlignment: WrapCrossAlignment.center,
                                children: [
                                  SegmentedButton<String>(
                                    segments: const [
                                      ButtonSegment(
                                        value: 'auto',
                                        label: Text('Orchestrate'),
                                        icon: Icon(
                                          Icons.account_tree_outlined,
                                          size: 16,
                                        ),
                                      ),
                                      ButtonSegment(
                                        value: 'direct',
                                        label: Text('Direct'),
                                        icon: Icon(
                                          Icons.arrow_forward_rounded,
                                          size: 16,
                                        ),
                                      ),
                                    ],
                                    selected: {strategy},
                                    showSelectedIcon: false,
                                    style: const ButtonStyle(
                                      visualDensity: VisualDensity.compact,
                                    ),
                                    onSelectionChanged: (value) =>
                                        setState(() => strategy = value.first),
                                  ),
                                  _ExecutionTargetMenu(
                                    value: executionTarget,
                                    localComputer: widget.localComputer,
                                    onChanged: (value) =>
                                        setState(() => executionTarget = value),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 8),
                            if (recording || widget.controller.transcribing)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 8),
                                child: Row(
                                  children: [
                                    Icon(
                                      recording
                                          ? Icons.mic_rounded
                                          : Icons.graphic_eq,
                                      color: recording
                                          ? Theme.of(context).colorScheme.error
                                          : Theme.of(context)
                                                .colorScheme
                                                .primary,
                                    ),
                                    const SizedBox(width: 8),
                                    Text(
                                      recording
                                          ? 'Recording · tap stop to review transcript'
                                          : 'Turning voice into an editable draft…',
                                    ),
                                  ],
                                ),
                              ),
                            if (recordingError != null ||
                                widget.controller.voiceError != null)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 8),
                                child: Align(
                                  alignment: Alignment.centerLeft,
                                  child: Text(
                                    recordingError ?? 'Voice transcription is temporarily unavailable.',
                                    style: TextStyle(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .error,
                                    ),
                                  ),
                                ),
                              ),
                            TextField(
                              controller: input,
                              focusNode: inputFocus,
                              autofocus:
                                  !kIsWeb &&
                                  defaultTargetPlatform == TargetPlatform.macOS,
                              minLines: 1,
                              maxLines: 5,
                              textInputAction: TextInputAction.send,
                              onSubmitted:
                                  widget.controller.transcribing || recording
                                  ? null
                                  : (_) => submit(),
                              decoration: InputDecoration(
                                hintText:
                                    'Describe an outcome or ask a question',
                                filled: true,
                                suffixIcon: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    IconButton(
                                      tooltip: recording
                                          ? 'Stop and transcribe voice draft'
                                          : 'Record voice draft',
                                      onPressed:
                                          widget.controller.sending ||
                                              widget.controller.transcribing
                                          ? null
                                          : toggleVoiceDraft,
                                      color: recording
                                          ? Theme.of(context).colorScheme.error
                                          : null,
                                      icon: Icon(
                                        recording
                                            ? Icons.stop_circle_outlined
                                            : Icons.mic_none_rounded,
                                      ),
                                    ),
                                    IconButton(
                                      tooltip: widget.controller.sending
                                          ? 'Add to prompt queue'
                                          : 'Send message',
                                      onPressed: recording ? null : submit,
                                      icon: Icon(
                                        widget.controller.sending
                                            ? Icons.playlist_add_rounded
                                            : Icons.arrow_upward_rounded,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            );
            if (constraints.maxWidth >= talkHistoryDesktopBreakpoint &&
                widget.controller.conversationHistorySupported) {
              return Row(
                children: [
                  SizedBox(
                    width: 272,
                    child: TalkHistoryPane(
                      controller: widget.controller,
                      onNew: () {
                        widget.controller.newConversation();
                        inputFocus.requestFocus();
                      },
                      onSelected: (id) =>
                          unawaited(widget.controller.openThread(id)),
                    ),
                  ),
                  Expanded(child: conversation),
                  SizedBox(
                    width: 328,
                    child: _TalkActivityPane(controller: widget.controller),
                  ),
                ],
              );
            }
            if (constraints.maxWidth < 1180) return conversation;
            return Row(
              children: [
                Expanded(child: conversation),
                SizedBox(
                  width: 348,
                  child: _TalkActivityPane(controller: widget.controller),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

enum _TalkRailSection { activity, artifacts, queue }

class _ExecutionTargetMenu extends StatelessWidget {
  const _ExecutionTargetMenu({
    required this.value,
    required this.onChanged,
    this.localComputer,
    this.compact = false,
  });

  final TalkExecutionTarget value;
  final ValueChanged<TalkExecutionTarget> onChanged;
  final LocalComputerCoordinator? localComputer;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final coordinator = localComputer;
    if (coordinator == null) return _menu(context, null);
    return ListenableBuilder(
      listenable: coordinator,
      builder: (context, _) => _menu(context, coordinator),
    );
  }

  Widget _menu(BuildContext context, LocalComputerCoordinator? coordinator) {
    final scheme = Theme.of(context).colorScheme;
    final macReady = coordinator?.ready == true;
    final macActive = coordinator?.active == true;
    final status = coordinator == null
        ? 'This Mac status is unavailable in this client.'
        : switch (coordinator.phase) {
            LocalComputerBrokerPhase.ready => 'This Mac is ready.',
            LocalComputerBrokerPhase.active =>
              'Asael is currently operating this Mac.',
            LocalComputerBrokerPhase.permissionsRequired =>
              'This Mac needs Accessibility and Screen Recording permission.',
            LocalComputerBrokerPhase.disabled ||
            LocalComputerBrokerPhase.stopped =>
              'Local Computer Use is disabled in Settings.',
            LocalComputerBrokerPhase.degraded =>
              'This Mac is reconnecting to the command service.',
            LocalComputerBrokerPhase.starting => 'This Mac status is loading.',
            LocalComputerBrokerPhase.unavailable =>
              'Local Computer Use is available only in the signed macOS app.',
          };
    return Semantics(
      label: 'Execution target: ${value.label}. $status',
      button: true,
      child: Tooltip(
        message: value == TalkExecutionTarget.thisMac ? status : value.detail,
        child: PopupMenuButton<TalkExecutionTarget>(
          key: const ValueKey('talk-execution-target'),
          initialValue: value,
          tooltip: 'Choose where computer actions run',
          onSelected: onChanged,
          itemBuilder: (context) => [
            for (final target in TalkExecutionTarget.values)
              PopupMenuItem(
                value: target,
                child: ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(target.icon, size: 19),
                  title: Text(target.label),
                  subtitle: Text(target.detail),
                  trailing: target == TalkExecutionTarget.thisMac
                      ? Icon(
                          macActive
                              ? Icons.radio_button_checked_rounded
                              : macReady
                              ? Icons.check_circle_rounded
                              : Icons.warning_amber_rounded,
                          size: 17,
                          color: macActive || macReady
                              ? scheme.primary
                              : scheme.onSurfaceVariant,
                        )
                      : null,
                ),
              ),
          ],
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: value == TalkExecutionTarget.thisMac
                  ? scheme.primaryContainer.withValues(alpha: .56)
                  : scheme.surfaceContainerLow,
              border: Border.all(color: scheme.outlineVariant),
              borderRadius: BorderRadius.circular(11),
            ),
            child: Padding(
              padding: EdgeInsets.symmetric(
                horizontal: compact ? 9 : 11,
                vertical: compact ? 6 : 7,
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(value.icon, size: 16),
                  const SizedBox(width: 7),
                  Text(
                    value.label,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  if (value == TalkExecutionTarget.thisMac) ...[
                    const SizedBox(width: 7),
                    Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: macActive || macReady
                            ? scheme.primary
                            : scheme.outline,
                      ),
                    ),
                  ],
                  const SizedBox(width: 4),
                  const Icon(Icons.expand_more_rounded, size: 16),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _TalkActivityPane extends StatefulWidget {
  const _TalkActivityPane({required this.controller});

  final TalkController controller;

  @override
  State<_TalkActivityPane> createState() => _TalkActivityPaneState();
}

class _TalkActivityPaneState extends State<_TalkActivityPane> {
  _TalkRailSection section = _TalkRailSection.activity;

  TalkController get controller => widget.controller;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final activeCount = controller.activities
        .where((item) => item.state == TalkActivityState.active)
        .length;
    final (icon, title, detail) = switch (section) {
      _TalkRailSection.activity => (
        Icons.hub_outlined,
        'Live activity',
        'Tools, specialists, and approvals',
      ),
      _TalkRailSection.artifacts => (
        Icons.auto_awesome_mosaic_outlined,
        'Artifacts',
        'Preview and save generated work',
      ),
      _TalkRailSection.queue => (
        Icons.playlist_play_rounded,
        'Prompt queue',
        'Shape what Asael does next',
      ),
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surface.withValues(alpha: .78),
        border: Border(left: BorderSide(color: scheme.outlineVariant)),
      ),
      child: SafeArea(
        left: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 14),
              child: Row(
                children: [
                  Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(
                      color: scheme.primaryContainer,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Icon(icon, size: 18, color: scheme.primary),
                  ),
                  const SizedBox(width: 11),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                        Text(detail, style: const TextStyle(fontSize: 11.5)),
                      ],
                    ),
                  ),
                  if (section == _TalkRailSection.activity &&
                      (controller.sending || activeCount > 0))
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: scheme.primaryContainer,
                        borderRadius: BorderRadius.circular(99),
                      ),
                      child: Text(
                        activeCount > 0 ? '$activeCount active' : 'Live',
                        style: TextStyle(
                          color: scheme.primary,
                          fontSize: 10.5,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  if (controller.sending && controller.runId != null) ...[
                    const SizedBox(width: 4),
                    IconButton(
                      tooltip: 'Stop this run',
                      onPressed: controller.canceling
                          ? null
                          : controller.cancel,
                      icon: controller.canceling
                          ? const SizedBox.square(
                              dimension: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.stop_circle_outlined, size: 20),
                    ),
                  ],
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
              child: SegmentedButton<_TalkRailSection>(
                segments: [
                  const ButtonSegment(
                    value: _TalkRailSection.activity,
                    icon: Icon(Icons.bolt_outlined, size: 16),
                    tooltip: 'Live activity',
                  ),
                  ButtonSegment(
                    value: _TalkRailSection.artifacts,
                    icon: const Icon(Icons.description_outlined, size: 16),
                    label: controller.artifacts.isEmpty
                        ? null
                        : Text('${controller.artifacts.length}'),
                    tooltip: 'Artifacts',
                  ),
                  ButtonSegment(
                    value: _TalkRailSection.queue,
                    icon: const Icon(Icons.playlist_play_rounded, size: 16),
                    label: controller.promptQueue.isEmpty
                        ? null
                        : Text('${controller.promptQueue.length}'),
                    tooltip: 'Prompt queue',
                  ),
                ],
                selected: {section},
                showSelectedIcon: false,
                expandedInsets: EdgeInsets.zero,
                onSelectionChanged: (value) {
                  setState(() => section = value.first);
                },
              ),
            ),
            Divider(height: 1, color: scheme.outlineVariant),
            Expanded(
              child: switch (section) {
                _TalkRailSection.activity => _activityBody(context),
                _TalkRailSection.artifacts => _artifactBody(context),
                _TalkRailSection.queue => _queueBody(context),
              },
            ),
            if (controller.runId != null)
              Container(
                padding: const EdgeInsets.fromLTRB(18, 10, 18, 12),
                decoration: BoxDecoration(
                  border: Border(top: BorderSide(color: scheme.outlineVariant)),
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.shield_outlined,
                      size: 14,
                      color: scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(
                        'Governed run ${_shortId(controller.runId!)}',
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: scheme.onSurfaceVariant,
                          fontSize: 11,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  static String _shortId(String value) =>
      value.length <= 12 ? value : value.substring(0, 12);

  Widget _activityBody(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (controller.activities.isEmpty) {
      return _RailEmpty(
        icon: Icons.route_outlined,
        title: 'Activity will appear here',
        detail: 'Asael shows observable run decisions without exposing private reasoning.',
        color: scheme.onSurfaceVariant,
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      itemCount: controller.activities.length,
      separatorBuilder: (_, _) => const SizedBox(height: 9),
      itemBuilder: (context, index) =>
          _TalkActivityCard(activity: controller.activities[index]),
    );
  }

  Widget _artifactBody(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (controller.artifacts.isEmpty) {
      return _RailEmpty(
        icon: Icons.description_outlined,
        title: 'No artifacts yet',
        detail: 'Images, video, files, and Computer Use evidence from completed runs appear here.',
        color: scheme.onSurfaceVariant,
      );
    }
    final selected = controller.selectedArtifact;
    final content = controller.selectedArtifactContent;
    return Column(
      children: [
        if (selected != null)
          Container(
            margin: const EdgeInsets.fromLTRB(14, 14, 14, 4),
            decoration: BoxDecoration(
              color: scheme.surfaceContainerLowest,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: scheme.outlineVariant),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AspectRatio(
                  aspectRatio: 16 / 10,
                  child: ColoredBox(
                    color: scheme.surfaceContainerHighest,
                    child: controller.artifactLoading
                        ? const Center(child: CircularProgressIndicator())
                        : content != null &&
                              (selected.kind == 'image' ||
                                  selected.kind == 'computer')
                        ? Image.memory(
                            content.bytes,
                            fit: BoxFit.contain,
                            errorBuilder: (_, _, _) => _artifactPlaceholder(
                              context,
                              selected,
                              'Preview could not be decoded',
                            ),
                          )
                        : _artifactPlaceholder(
                            context,
                            selected,
                            controller.artifactError == null
                                ? 'Ready to save'
                                : 'Preview unavailable',
                          ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 10, 8, 8),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              selected.filename,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 12.5,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            Text(
                              '${selected.mediaType} · ${TalkController._humanBytes(selected.byteCount)}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: scheme.onSurfaceVariant,
                                fontSize: 10.5,
                              ),
                            ),
                          ],
                        ),
                      ),
                      IconButton(
                        tooltip: 'Save artifact as…',
                        onPressed: content == null
                            ? null
                            : () => _saveArtifact(selected, content.bytes),
                        icon: const Icon(Icons.download_rounded, size: 19),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 22),
            itemCount: controller.artifacts.length,
            separatorBuilder: (_, _) => const SizedBox(height: 7),
            itemBuilder: (context, index) {
              final artifact = controller.artifacts[index];
              final isSelected = selected?.assetId == artifact.assetId;
              return Material(
                color: isSelected
                    ? scheme.primaryContainer.withValues(alpha: .7)
                    : scheme.surfaceContainerLow,
                borderRadius: BorderRadius.circular(12),
                child: ListTile(
                  dense: true,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                  leading: Icon(
                    artifact.kind == 'computer'
                        ? Icons.screenshot_monitor_outlined
                        : artifact.kind == 'image'
                        ? Icons.image_outlined
                        : Icons.movie_outlined,
                    color: isSelected ? scheme.primary : null,
                  ),
                  title: Text(
                    artifact.filename,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(
                    '${artifact.contextLabel ?? TalkController._sentenceCase(artifact.operation)} · ${artifact.status}',
                    maxLines: 1,
                  ),
                  onTap: () => controller.selectArtifact(artifact),
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _artifactPlaceholder(
    BuildContext context,
    TalkMediaArtifactSummary artifact,
    String label,
  ) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            artifact.kind == 'computer'
                ? Icons.screenshot_monitor_outlined
                : artifact.kind == 'video'
                ? Icons.play_circle_outline_rounded
                : Icons.broken_image_outlined,
            size: 38,
            color: scheme.onSurfaceVariant,
          ),
          const SizedBox(height: 7),
          Text(
            label,
            style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 11.5),
          ),
        ],
      ),
    );
  }

  Future<void> _saveArtifact(
    TalkMediaArtifactSummary artifact,
    Uint8List bytes,
  ) async {
    await FilePicker.saveFile(
      dialogTitle: 'Save ${artifact.filename}',
      fileName: artifact.filename,
      bytes: bytes,
    );
  }

  Widget _queueBody(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  controller.queuePaused
                      ? 'Paused for review'
                      : controller.sending
                      ? 'Runs after the current prompt'
                      : 'Runs in this order',
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    fontSize: 11.5,
                  ),
                ),
              ),
              TextButton.icon(
                onPressed: controller.promptQueue.isEmpty
                    ? null
                    : controller.queuePaused
                    ? controller.resumeQueue
                    : controller.pauseQueue,
                icon: Icon(
                  controller.queuePaused
                      ? Icons.play_arrow_rounded
                      : Icons.pause_rounded,
                  size: 17,
                ),
                label: Text(controller.queuePaused ? 'Resume' : 'Pause'),
              ),
            ],
          ),
        ),
        Expanded(
          child: controller.promptQueue.isEmpty
              ? _RailEmpty(
                  icon: Icons.playlist_add_check_circle_outlined,
                  title: 'Queue is clear',
                  detail: 'Send another prompt while Asael is working to add it here.',
                  color: scheme.onSurfaceVariant,
                )
              : ReorderableListView.builder(
                  padding: const EdgeInsets.fromLTRB(14, 4, 14, 24),
                  itemCount: controller.promptQueue.length,
                  onReorderItem: (oldIndex, newIndex) {
                    controller.moveQueuedPrompt(
                      controller.promptQueue[oldIndex].id,
                      newIndex - oldIndex,
                    );
                  },
                  itemBuilder: (context, index) {
                    final prompt = controller.promptQueue[index];
                    return Padding(
                      key: ValueKey(prompt.id),
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Material(
                        color: scheme.surfaceContainerLow,
                        borderRadius: BorderRadius.circular(12),
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(12, 10, 6, 7),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Container(
                                    width: 22,
                                    height: 22,
                                    alignment: Alignment.center,
                                    decoration: BoxDecoration(
                                      color: scheme.primaryContainer,
                                      borderRadius: BorderRadius.circular(7),
                                    ),
                                    child: Text(
                                      '${index + 1}',
                                      style: TextStyle(
                                        color: scheme.primary,
                                        fontSize: 10,
                                        fontWeight: FontWeight.w800,
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: 9),
                                  Expanded(
                                    child: Text(
                                      prompt.input,
                                      maxLines: 4,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        fontSize: 12,
                                        height: 1.35,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 5),
                              Row(
                                children: [
                                  Icon(
                                    prompt.executionTarget.icon,
                                    size: 14,
                                    color: scheme.onSurfaceVariant,
                                  ),
                                  const SizedBox(width: 5),
                                  Expanded(
                                    child: Text(
                                      prompt.executionTarget.label,
                                      style: TextStyle(
                                        color: scheme.onSurfaceVariant,
                                        fontSize: 10.5,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                  ),
                                  IconButton(
                                    tooltip: 'Edit prompt',
                                    visualDensity: VisualDensity.compact,
                                    onPressed: () => _editPrompt(prompt),
                                    icon: const Icon(
                                      Icons.edit_outlined,
                                      size: 17,
                                    ),
                                  ),
                                  IconButton(
                                    tooltip: controller.sending
                                        ? 'Make this next'
                                        : 'Run now',
                                    visualDensity: VisualDensity.compact,
                                    onPressed: () =>
                                        controller.runQueuedPrompt(prompt.id),
                                    icon: const Icon(
                                      Icons.play_arrow_rounded,
                                      size: 19,
                                    ),
                                  ),
                                  IconButton(
                                    tooltip: 'Remove prompt',
                                    visualDensity: VisualDensity.compact,
                                    onPressed: () => controller
                                        .removeQueuedPrompt(prompt.id),
                                    icon: const Icon(
                                      Icons.close_rounded,
                                      size: 17,
                                    ),
                                  ),
                                  const Icon(
                                    Icons.drag_handle_rounded,
                                    size: 18,
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }

  Future<void> _editPrompt(TalkQueuedPrompt prompt) async {
    final updated = await showDialog<String>(
      context: context,
      builder: (_) => _EditQueuedPromptDialog(prompt: prompt.input),
    );
    if (updated != null) controller.updateQueuedPrompt(prompt.id, updated);
  }
}

class _RailEmpty extends StatelessWidget {
  const _RailEmpty({
    required this.icon,
    required this.title,
    required this.detail,
    required this.color,
  });

  final IconData icon;
  final String title;
  final String detail;
  final Color color;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 28, color: color),
          const SizedBox(height: 10),
          Text(title, style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 5),
          Text(
            detail,
            textAlign: TextAlign.center,
            style: TextStyle(color: color, fontSize: 12),
          ),
        ],
      ),
    ),
  );
}

class _EditQueuedPromptDialog extends StatefulWidget {
  const _EditQueuedPromptDialog({required this.prompt});
  final String prompt;

  @override
  State<_EditQueuedPromptDialog> createState() =>
      _EditQueuedPromptDialogState();
}

class _EditQueuedPromptDialogState extends State<_EditQueuedPromptDialog> {
  late final TextEditingController controller = TextEditingController(
    text: widget.prompt,
  );

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Edit queued prompt'),
    content: SizedBox(
      width: 520,
      child: TextField(
        controller: controller,
        autofocus: true,
        minLines: 4,
        maxLines: 12,
        maxLength: 20000,
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: () {
          final value = controller.text.trim();
          if (value.isNotEmpty) Navigator.of(context).pop(value);
        },
        child: const Text('Save'),
      ),
    ],
  );
}

class _TalkActivityCard extends StatelessWidget {
  const _TalkActivityCard({required this.activity});

  final TalkActivity activity;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (icon, color) = switch (activity.state) {
      TalkActivityState.active => (
        Icons.motion_photos_on_outlined,
        scheme.primary,
      ),
      TalkActivityState.succeeded => (
        Icons.check_circle_outline,
        scheme.tertiary,
      ),
      TalkActivityState.waiting => (Icons.schedule_rounded, scheme.secondary),
      TalkActivityState.failed => (Icons.error_outline_rounded, scheme.error),
      TalkActivityState.info => (
        Icons.info_outline_rounded,
        scheme.onSurfaceVariant,
      ),
    };
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow.withValues(alpha: .84),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant.withValues(alpha: .8)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Icon(icon, size: 17, color: color),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  activity.title,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  activity.detail,
                  maxLines: 4,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    fontSize: 11.5,
                    height: 1.35,
                  ),
                ),
                if (activity.actionLabel != null &&
                    activity.actionRoute != null) ...[
                  const SizedBox(height: 7),
                  Row(
                    children: [
                      TextButton.icon(
                        onPressed: () => context.go(activity.actionRoute!),
                        icon: const Icon(Icons.arrow_forward_rounded, size: 15),
                        label: Text(activity.actionLabel!),
                        style: TextButton.styleFrom(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 5,
                          ),
                          minimumSize: Size.zero,
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                      ),
                      if (appDesktopHostBridge.supported &&
                          DesktopHostBridge.isWorkspaceRoute(
                            activity.actionRoute!,
                          ))
                        IconButton(
                          tooltip: 'Open in a new window',
                          visualDensity: VisualDensity.compact,
                          onPressed: () => appDesktopHostBridge
                              .openWorkspaceWindow(activity.actionRoute!),
                          icon: const Icon(Icons.open_in_new_rounded, size: 15),
                        ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _TalkEmpty extends StatelessWidget {
  const _TalkEmpty({required this.selectedThread, required this.loading});

  final bool selectedThread;
  final bool loading;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (loading)
            const SizedBox.square(
              dimension: 38,
              child: CircularProgressIndicator(strokeWidth: 2.5),
            )
          else
            const AsaelMark(size: 52),
          const SizedBox(height: 20),
          Text(
            loading
                ? 'Opening conversation'
                : selectedThread
                ? 'This conversation is empty'
                : 'What needs to move?',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          Text(
            loading
                ? 'Reading the latest public message projection.'
                : selectedThread
                ? 'Send a message to continue this durable conversation.'
                : 'Ask a question or describe an outcome. Asael will keep plans, evidence, and approvals connected.',
            textAlign: TextAlign.center,
          ),
        ],
      ),
    ),
  );
}
