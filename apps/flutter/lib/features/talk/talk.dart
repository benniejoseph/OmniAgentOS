import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:record/record.dart';

import '../../app/brand/asael_mark.dart';
import '../../generated/native_contract.g.dart';

typedef Json = Map<String, dynamic>;

Json _jsonRecord(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

String _boundedDisplayText(Object? value, int maximum) {
  if (value is! String) return '';
  final normalized = value.replaceAll(RegExp(r'\s+'), ' ').trim();
  return normalized.length <= maximum ? normalized : '';
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
  });

  final String assetId;
  final String kind;
  final String operation;
  final String filename;
  final String mediaType;
  final int byteCount;
  final String status;
}

class TalkRunInspection {
  const TalkRunInspection({
    required this.runId,
    required this.status,
    required this.grounding,
    required this.agentIdentity,
    required this.mediaArtifacts,
  });

  final String runId;
  final String status;
  final TalkGroundingSummary grounding;
  final TalkAgentIdentitySummary agentIdentity;
  final List<TalkMediaArtifactSummary> mediaArtifacts;

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
  });
  Future<String> transcribeVoice(Uint8List bytes);
  Future<void> cancelRun(String runId);
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId);
  Future<TalkRunInspection> inspectRun(String runId);
}

class TalkController extends ChangeNotifier {
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
  final _workflowIds = <String>[];
  final _workflowMonitorTokens = <String, Object>{};
  final _inspectedRunIds = <String>{};
  String? threadId;
  String? runId;
  String? status;
  bool sending = false;
  bool canceling = false;
  bool transcribing = false;
  Object? voiceError;
  bool _disposed = false;

  List<String> get workflowIds => List.unmodifiable(_workflowIds);
  Set<String> get monitoringWorkflowIds =>
      Set.unmodifiable(_workflowMonitorTokens.keys);
  Future<void> send(
    String input, {
    String mode = 'orchestrate',
    String strategy = 'auto',
  }) async {
    return _send(input, mode: mode, strategy: strategy);
  }

  String? _retryInput;
  String? _retryMode;
  String? _retryStrategy;

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
      )) {
        if (event.data['threadId'] is String) {
          threadId = event.data['threadId'] as String;
        }
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
    } catch (_) {
      messages[messages.length - 1] = messages.last.copyWith(
        text: messages.last.text.isEmpty
            ? 'I could not reach Asael. Tap retry when you’re back online.'
            : messages.last.text,
        streaming: false,
        failed: true,
      );
      _retryInput = text;
      _retryMode = mode;
      _retryStrategy = strategy;
      _recordActivity(
        key: 'run',
        title: 'Main agent',
        detail: 'The connection ended before the run completed.',
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
    this.onExitQuickEntry,
  });

  final TalkController controller;
  final VoiceDraftRecorder? voiceRecorder;
  final bool quickEntry;
  final VoidCallback? onExitQuickEntry;
  @override
  State<TalkView> createState() => _TalkViewState();
}

class _TalkViewState extends State<TalkView> with WidgetsBindingObserver {
  final input = TextEditingController();
  final inputFocus = FocusNode(debugLabel: 'Asael command composer');
  final scroll = ScrollController();
  late final VoiceDraftRecorder recorder;
  String strategy = 'auto';
  bool recording = false;
  String? recordingError;
  int voiceDraftGeneration = 0;

  @override
  void initState() {
    super.initState();
    recorder = widget.voiceRecorder ?? RecordVoiceDraftRecorder();
    WidgetsBinding.instance.addObserver(this);
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
    if (value.isEmpty || widget.controller.sending) return;
    input.clear();
    final work = widget.controller.send(
      value,
      mode: 'orchestrate',
      strategy: strategy,
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
                          TextField(
                            key: const ValueKey('quick-entry-input'),
                            controller: input,
                            focusNode: inputFocus,
                            autofocus: true,
                            minLines: 1,
                            maxLines: 4,
                            textInputAction: TextInputAction.send,
                            onSubmitted: widget.controller.sending
                                ? null
                                : (_) => submit(),
                            decoration: InputDecoration(
                              hintText: 'What needs to move?',
                              filled: true,
                              suffixIcon: IconButton(
                                tooltip: 'Send and open Conversation',
                                onPressed: widget.controller.sending
                                    ? null
                                    : submit,
                                icon: const Icon(Icons.arrow_upward_rounded),
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
                                      'Orchestrate · governed · Esc to close',
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
        title: const Text('Conversation'),
        actions: [
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
                Expanded(
                  child: widget.controller.messages.isEmpty
                      ? const _TalkEmpty()
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
                              child: SegmentedButton<String>(
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
                                  widget.controller.sending ||
                                      widget.controller.transcribing ||
                                      recording
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
                                      tooltip: 'Send message',
                                      onPressed:
                                          widget.controller.sending || recording
                                          ? null
                                          : submit,
                                      icon: const Icon(
                                        Icons.arrow_upward_rounded,
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

class _TalkActivityPane extends StatelessWidget {
  const _TalkActivityPane({required this.controller});

  final TalkController controller;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final activeCount = controller.activities
        .where((item) => item.state == TalkActivityState.active)
        .length;
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
                    child: Icon(
                      Icons.hub_outlined,
                      size: 18,
                      color: scheme.primary,
                    ),
                  ),
                  const SizedBox(width: 11),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Live activity',
                          style: TextStyle(fontWeight: FontWeight.w700),
                        ),
                        Text(
                          'Tools, specialists, and approvals',
                          style: TextStyle(fontSize: 11.5),
                        ),
                      ],
                    ),
                  ),
                  if (controller.sending || activeCount > 0)
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
            Divider(height: 1, color: scheme.outlineVariant),
            Expanded(
              child: controller.activities.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(28),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              Icons.route_outlined,
                              size: 28,
                              color: scheme.onSurfaceVariant,
                            ),
                            const SizedBox(height: 10),
                            Text(
                              'Activity will appear here',
                              style: Theme.of(context).textTheme.titleSmall,
                            ),
                            const SizedBox(height: 5),
                            Text(
                              'Asael shows observable run decisions without exposing private reasoning.',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                color: scheme.onSurfaceVariant,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                      ),
                    )
                  : ListView.separated(
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                      itemCount: controller.activities.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 9),
                      itemBuilder: (context, index) => _TalkActivityCard(
                        activity: controller.activities[index],
                      ),
                    ),
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
  const _TalkEmpty();
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const AsaelMark(size: 52),
          const SizedBox(height: 20),
          Text(
            'What needs to move?',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          const Text(
            'Ask a question or describe an outcome. Asael will keep plans, evidence, and approvals connected.',
            textAlign: TextAlign.center,
          ),
        ],
      ),
    ),
  );
}
