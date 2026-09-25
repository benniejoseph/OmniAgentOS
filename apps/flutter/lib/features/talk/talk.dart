import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:file_picker/file_picker.dart';
import 'package:go_router/go_router.dart';
import 'package:record/record.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/brand/asael_mascot.dart';
import '../../app/brand/asael_mark.dart';
import '../../app/platform/macos_presentation.dart';
import '../../app/theme/macos_app_theme.dart';
import '../../core/network/api_exception.dart';
import '../../core/platform/desktop_host_bridge.dart';
import '../../core/platform/local_computer_bridge.dart';
import '../../generated/native_contract.g.dart';
import '../ambient_voice/ambient_voice_view.dart';
import '../ambient_voice/realtime_voice_controller.dart';
import '../computer_use/local_computer.dart';
import 'talk_command_context.dart';
import 'talk_history.dart';
import 'talk_history_view.dart';
import 'talk_model_selection.dart';
import 'talk_rich_message.dart';

export 'talk_history.dart';
export 'talk_command_context.dart';
export 'talk_model_selection.dart';

typedef Json = Map<String, dynamic>;

Json _jsonRecord(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

String _boundedDisplayText(Object? value, int maximum) {
  if (value is! String) return '';
  final normalized = value.replaceAll(RegExp(r'\s+'), ' ').trim();
  return normalized.length <= maximum ? normalized : '';
}

String _boundedArtifactText(Object? value, int maximum) {
  if (value is! String) return '';
  final normalized = value
      .replaceAll(RegExp(r'[\u0000-\u001F\u007F]'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  return normalized.isNotEmpty && normalized.length <= maximum
      ? normalized
      : '';
}

String _boundedRunText(Object? value, int maximum) {
  if (value is! String || maximum < 1) return '';
  final normalized = value
      .replaceAll(
        RegExp(r'[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]'),
        ' ',
      )
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .trim();
  if (normalized.isEmpty) return '';
  final runes = normalized.runes;
  return runes.length <= maximum
      ? normalized
      : '${String.fromCharCodes(runes.take(maximum - 1))}\u2026';
}

({String message, String detail}) _talkFailure(Object error) {
  if (error is ApiException) {
    final code = _boundedDisplayText(error.diagnosticCode, 80);
    final statusCode = error.statusCode;
    if (statusCode != null && statusCode >= 400 && statusCode < 500) {
      return (
        message: _boundedDisplayText(error.message, 400).isNotEmpty
            ? _boundedDisplayText(error.message, 400)
            : 'Asael could not start this request.',
        detail:
            'The command was rejected before a governed run started (HTTP $statusCode${code.isEmpty ? '' : ', $code'}).',
      );
    }
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

  // Dio exposes ResponseBody.stream as Stream<Uint8List>. Cast each chunk to
  // the decoder's List<int> contract so generic runtime checks do not reject
  // a valid Uint8List stream before the first SSE event is delivered.
  await for (final chunk in bytes.cast<List<int>>().transform(utf8.decoder)) {
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

enum TalkExecutionTarget { agent, thisMac }

extension TalkExecutionTargetPresentation on TalkExecutionTarget {
  String get label => switch (this) {
    TalkExecutionTarget.agent => 'Asael only',
    TalkExecutionTarget.thisMac => 'This Mac',
  };

  String get detail => switch (this) {
    TalkExecutionTarget.agent => 'No computer control',
    TalkExecutionTarget.thisMac => 'Use this installed Mac',
  };

  String? get apiValue => switch (this) {
    TalkExecutionTarget.agent => null,
    TalkExecutionTarget.thisMac => 'local_macos',
  };

  IconData get icon => switch (this) {
    TalkExecutionTarget.agent => Icons.auto_awesome_outlined,
    TalkExecutionTarget.thisMac => Icons.laptop_mac_rounded,
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
    this.externalUri,
  });

  final String key;
  final String title;
  final String detail;
  final TalkActivityState state;
  final String? actionLabel;
  final String? actionRoute;
  final Uri? externalUri;
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
    this.artifactVersion,
    this.title,
    this.slideCount,
    this.theme,
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
  final int? artifactVersion;
  final String? title;
  final int? slideCount;
  final String? theme;

  bool get isPresentation => kind == 'presentation' && artifactVersion != null;

  String get identityKey =>
      artifactVersion == null ? assetId : '$assetId:$artifactVersion';

  static const powerPointMediaType =
      'application/vnd.openxmlformats-officedocument.presentationml.presentation';
}

class TalkWorkspaceArtifactSummary {
  const TalkWorkspaceArtifactSummary({
    required this.executionId,
    required this.sequence,
    required this.kind,
    required this.resourceId,
    required this.title,
    required this.createdAt,
  });

  final String executionId;
  final int sequence;
  final String kind;
  final String resourceId;
  final String title;
  final DateTime createdAt;

  String get typeLabel => switch (kind) {
    'document' => 'Google Doc',
    'spreadsheet' => 'Google Sheet',
    _ => 'Google Slides',
  };

  Uri get editorUri {
    final product = switch (kind) {
      'document' => 'document',
      'spreadsheet' => 'spreadsheets',
      _ => 'presentation',
    };
    return Uri.https('docs.google.com', '/$product/d/$resourceId/edit');
  }
}

class TalkArtifactContent {
  const TalkArtifactContent({
    required this.assetId,
    required this.bytes,
    this.terminal,
  });

  final String assetId;
  final Uint8List bytes;
  final LocalComputerTerminalPreview? terminal;
}

class LegacyComputerPreviewRetired implements Exception {
  const LegacyComputerPreviewRetired();

  @override
  String toString() =>
      'Legacy Isolated Browser previews are retired. Use This Mac to capture a new private screenshot.';
}

class TalkWaitingApprovalSummary {
  const TalkWaitingApprovalSummary({
    required this.executionId,
    required this.toolId,
    required this.toolName,
  });

  final String executionId;
  final String toolId;
  final String toolName;
}

@immutable
class TalkAssignedAgent {
  const TalkAssignedAgent({required this.id, required this.name});

  final String id;
  final String name;
}

class TalkQueuedPrompt {
  const TalkQueuedPrompt({
    required this.id,
    required this.clientCorrelationId,
    required this.input,
    required this.mode,
    required this.strategy,
    required this.executionTarget,
    this.assignedAgent,
    this.threadId,
    this.contextReferences = const [],
    this.modelSelection,
    this.lifecycleRevision = 0,
    this.state = 'queued',
    this.providerId,
    this.modelId,
    this.agentDefinitionVersion,
    this.progressLabel,
    this.failureCode,
    this.syncState = TalkPromptQueueSyncState.synced,
  });

  final String id;
  final String input;
  final String mode;
  final String strategy;
  final TalkExecutionTarget executionTarget;
  final TalkAssignedAgent? assignedAgent;
  final String? threadId;
  final List<TalkCommandContextReference> contextReferences;
  final TalkCommandModelSelection? modelSelection;
  final String clientCorrelationId;
  final int lifecycleRevision;
  final String state;
  final String? providerId;
  final String? modelId;
  final int? agentDefinitionVersion;
  final String? progressLabel;
  final String? failureCode;
  final TalkPromptQueueSyncState syncState;

  bool get serverBacked =>
      RegExp(r'^[a-f0-9-]{36}$', caseSensitive: false).hasMatch(id);
  bool get editable => const {'queued', 'paused', 'failed'}.contains(state);

  TalkQueuedPrompt copyWith({
    String? id,
    String? input,
    int? lifecycleRevision,
    String? state,
    String? progressLabel,
    String? failureCode,
    TalkPromptQueueSyncState? syncState,
  }) => TalkQueuedPrompt(
    id: id ?? this.id,
    input: input ?? this.input,
    mode: mode,
    strategy: strategy,
    executionTarget: executionTarget,
    assignedAgent: assignedAgent,
    threadId: threadId,
    contextReferences: contextReferences,
    modelSelection: modelSelection,
    clientCorrelationId: clientCorrelationId,
    lifecycleRevision: lifecycleRevision ?? this.lifecycleRevision,
    state: state ?? this.state,
    providerId: providerId,
    modelId: modelId,
    agentDefinitionVersion: agentDefinitionVersion,
    progressLabel: progressLabel ?? this.progressLabel,
    failureCode: failureCode ?? this.failureCode,
    syncState: syncState ?? this.syncState,
  );
}

enum TalkPromptQueueSyncState { synced, pending, conflict }

bool _allActivePromptsPaused(Iterable<TalkQueuedPrompt> prompts) {
  final active = prompts
      .where((item) => item.state == 'queued' || item.state == 'paused')
      .toList(growable: false);
  return active.isNotEmpty && active.every((item) => item.state == 'paused');
}

abstract interface class TalkPromptQueueRepository {
  Future<List<TalkQueuedPrompt>> listPromptQueue();
  Future<TalkQueuedPrompt> createPromptQueueItem(TalkQueuedPrompt prompt);
  Future<TalkQueuedPrompt> updatePromptQueueItem(
    TalkQueuedPrompt prompt, {
    String? input,
    String? state,
  });
  Future<void> deletePromptQueueItem(TalkQueuedPrompt prompt);
  Future<List<TalkQueuedPrompt>> reorderPromptQueue(
    List<TalkQueuedPrompt> prompts,
  );
  Stream<SseEvent> dispatchPromptQueueItem(
    TalkQueuedPrompt prompt, {
    required bool force,
  });
  Future<List<TalkQueuedPrompt>> reconcilePromptQueue();
}

class TalkRunInspection {
  const TalkRunInspection({
    required this.runId,
    required this.status,
    required this.grounding,
    required this.agentIdentity,
    required this.mediaArtifacts,
    required this.fileArtifacts,
    required this.workspaceArtifacts,
    required this.workspaceArtifactState,
    this.threadId,
    this.response,
    this.error,
    this.waitingApproval,
  });

  final String runId;
  final String status;
  final String? threadId;
  final String? response;
  final String? error;
  final TalkWaitingApprovalSummary? waitingApproval;
  final TalkGroundingSummary grounding;
  final TalkAgentIdentitySummary agentIdentity;
  final List<TalkMediaArtifactSummary> mediaArtifacts;
  final List<TalkMediaArtifactSummary> fileArtifacts;
  final List<TalkWorkspaceArtifactSummary> workspaceArtifacts;
  final String workspaceArtifactState;

  bool get terminal =>
      const {'completed', 'failed', 'canceled'}.contains(status);

  factory TalkRunInspection.fromJson(Json payload) {
    final run = _jsonRecord(payload['run']);
    final runId = _boundedDisplayText(run['id'], 200);
    final status = _boundedDisplayText(run['status'], 40).toLowerCase();
    if (runId.isEmpty ||
        !const {
          'queued',
          'running',
          'waiting_clarification',
          'waiting_approval',
          'resuming',
          'completed',
          'failed',
          'canceled',
        }.contains(status)) {
      throw const FormatException('Invalid run evidence projection.');
    }
    final projectedThreadId = safeTalkHistoryId(run['threadId']);
    final response = _boundedRunText(run['response'], 40000);
    final error = _boundedRunText(run['error'], 2000);
    final rawWaitingApproval = _jsonRecord(run['waitingApproval']);
    final waitingExecutionId = safeTalkHistoryId(
      rawWaitingApproval['executionId'],
    );
    final waitingToolId = _boundedDisplayText(
      rawWaitingApproval['toolId'],
      200,
    );
    final waitingToolName = _boundedDisplayText(
      rawWaitingApproval['toolName'],
      200,
    );
    final waitingApproval =
        status == 'waiting_approval' &&
            waitingExecutionId.isNotEmpty &&
            waitingToolId.isNotEmpty
        ? TalkWaitingApprovalSummary(
            executionId: waitingExecutionId,
            toolId: waitingToolId,
            toolName: waitingToolName.isEmpty
                ? 'A governed action'
                : waitingToolName,
          )
        : null;

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

    final fileArtifacts = <TalkMediaArtifactSummary>[];
    final seenFileVersions = <String>{};
    final rawFileArtifacts = payload['fileArtifacts'];
    if (rawFileArtifacts is List) {
      for (final candidate in rawFileArtifacts.take(32)) {
        final artifact = _jsonRecord(candidate);
        final artifactId = _boundedDisplayText(artifact['artifactId'], 200);
        final versionValue = artifact['version'];
        final version =
            versionValue is int &&
                versionValue >= 1 &&
                versionValue <= 2_147_483_647
            ? versionValue
            : null;
        final kind = _boundedDisplayText(artifact['kind'], 32).toLowerCase();
        final title = _boundedArtifactText(artifact['title'], 200);
        final filename = _boundedArtifactText(artifact['filename'], 240);
        final mediaType = _boundedDisplayText(
          artifact['mediaType'],
          160,
        ).toLowerCase();
        final artifactStatus = _boundedDisplayText(
          artifact['status'],
          30,
        ).toLowerCase();
        final byteCountValue = artifact['byteCount'];
        final byteCount =
            byteCountValue is int &&
                byteCountValue > 0 &&
                byteCountValue <= 64 * 1024 * 1024
            ? byteCountValue
            : null;
        final slideCountValue = artifact['slideCount'];
        final slideCount = slideCountValue == null
            ? null
            : slideCountValue is int &&
                  slideCountValue >= 1 &&
                  slideCountValue <= 24
            ? slideCountValue
            : -1;
        final themeValue = artifact['theme'];
        final theme = themeValue == null
            ? null
            : _boundedDisplayText(themeValue, 40).toLowerCase();
        final coordinate = '$artifactId:${version ?? 0}';
        if (artifactId.isEmpty ||
            !RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(artifactId) ||
            version == null ||
            !seenFileVersions.add(coordinate) ||
            kind != 'presentation' ||
            title.isEmpty ||
            filename.isEmpty ||
            !RegExp(
              r'^[^/\\]+\.pptx$',
              caseSensitive: false,
            ).hasMatch(filename) ||
            mediaType != TalkMediaArtifactSummary.powerPointMediaType ||
            artifactStatus != 'ready' ||
            byteCount == null ||
            slideCount == -1 ||
            (theme != null &&
                !const {'light', 'dark', 'aurora'}.contains(theme))) {
          continue;
        }
        fileArtifacts.add(
          TalkMediaArtifactSummary(
            assetId: artifactId,
            kind: kind,
            operation: 'create',
            filename: filename,
            mediaType: mediaType,
            byteCount: byteCount,
            status: artifactStatus,
            contextLabel: 'PowerPoint presentation · Private',
            artifactVersion: version,
            title: title,
            slideCount: slideCount,
            theme: theme,
          ),
        );
      }
    }

    final workspaceArtifacts = <TalkWorkspaceArtifactSummary>[];
    final seenWorkspaceResources = <String>{};
    final rawWorkspaceArtifacts = payload['workspaceArtifacts'];
    if (rawWorkspaceArtifacts is List) {
      for (final candidate in rawWorkspaceArtifacts.take(64)) {
        final artifact = _jsonRecord(candidate);
        final executionIdValue = artifact['executionId'];
        final executionId = executionIdValue is String
            ? executionIdValue.trim()
            : '';
        final sequence = artifact['sequence'];
        final kind = artifact['kind'];
        final resourceIdValue = artifact['resourceId'];
        final resourceId = resourceIdValue is String
            ? resourceIdValue.trim()
            : '';
        final titleValue = artifact['title'];
        final title = titleValue is String ? titleValue.trim() : '';
        final createdAtValue = artifact['createdAt'];
        final createdAt =
            createdAtValue is String &&
                RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$')
                    .hasMatch(createdAtValue)
            ? DateTime.tryParse(createdAtValue)?.toUtc()
            : null;
        if (!RegExp(r'^[A-Za-z0-9_.:@-]{1,240}$').hasMatch(executionId) ||
            sequence is! int ||
            sequence < 0 ||
            sequence > 100000 ||
            artifact['provider'] != 'google_workspace' ||
            !const {'document', 'spreadsheet', 'presentation'}.contains(kind) ||
            !RegExp(r'^[A-Za-z0-9_-]{10,240}$').hasMatch(resourceId) ||
            title.isEmpty ||
            title.length > 240 ||
            RegExp(r'[\u0000-\u001F\u007F]').hasMatch(title) ||
            createdAt == null ||
            !seenWorkspaceResources.add(resourceId)) {
          continue;
        }
        workspaceArtifacts.add(
          TalkWorkspaceArtifactSummary(
            executionId: executionId,
            sequence: sequence,
            kind: kind as String,
            resourceId: resourceId,
            title: title,
            createdAt: createdAt,
          ),
        );
      }
      workspaceArtifacts.sort(
        (left, right) => left.sequence.compareTo(right.sequence),
      );
    }
    final rawWorkspaceArtifactState = payload['workspaceArtifactState'];
    final workspaceArtifactState =
        rawWorkspaceArtifactState == 'ready' ||
            rawWorkspaceArtifactState == 'none' ||
            rawWorkspaceArtifactState == 'unavailable'
        ? rawWorkspaceArtifactState as String
        : 'none';

    return TalkRunInspection(
      runId: runId,
      status: status,
      threadId: projectedThreadId.isEmpty ? null : projectedThreadId,
      response: response.isEmpty ? null : response,
      error: error.isEmpty ? null : error,
      waitingApproval: waitingApproval,
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
      fileArtifacts: List.unmodifiable(fileArtifacts),
      workspaceArtifacts: List.unmodifiable(workspaceArtifacts),
      workspaceArtifactState: workspaceArtifactState,
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
    String? agentId,
    TalkCommandModelSelection? modelSelection,
  });
  Future<String> transcribeVoice(Uint8List bytes);
  Future<void> cancelRun(String runId);
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId);
  Future<TalkRunInspection> inspectRun(String runId);
}

abstract interface class TalkCommandContextRepository {
  Future<TalkCommandContextCatalog> loadCommandContextCatalog();

  Stream<SseEvent> sendWithCommandContext({
    required String message,
    required List<TalkCommandContextReference> contextReferences,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    String? agentId,
    TalkCommandModelSelection? modelSelection,
  });
}

abstract interface class TalkCommandModelSelectionRepository {
  Future<TalkCommandModelCatalog> loadCommandModelCatalog({
    required String commandScope,
  });
}

abstract interface class TalkArtifactRepository {
  Future<TalkArtifactContent> loadArtifact(TalkMediaArtifactSummary artifact);
}

class TalkController extends ChangeNotifier with TalkHistoryControllerMixin {
  TalkController(
    this.repository, {
    this.localComputerPreviews,
    this.workflowPollInterval = const Duration(seconds: 3),
    this.workflowPollLimit = 20,
    this.runRecoveryPollInterval = const Duration(seconds: 3),
    this.runRecoveryPollLimit = 200,
  }) : assert(workflowPollLimit > 0 && workflowPollLimit <= 120),
       assert(runRecoveryPollLimit > 0 && runRecoveryPollLimit <= 200);

  final TalkRepository repository;
  final LocalComputerPreviewSource? localComputerPreviews;
  final Duration workflowPollInterval;
  final int workflowPollLimit;
  final Duration runRecoveryPollInterval;
  final int runRecoveryPollLimit;
  final messages = <TalkMessage>[];
  final activities = <TalkActivity>[];
  final artifacts = <TalkMediaArtifactSummary>[];
  final _localPreviewArtifacts = <TalkMediaArtifactSummary>[];
  final _localPreviewContents = <String, TalkArtifactContent>{};
  final _localPreviewExpiryTimers = <String, Timer>{};
  final promptQueue = <TalkQueuedPrompt>[];
  final _workflowIds = <String>[];
  final _workflowMonitorTokens = <String, Object>{};
  final _inspectedRunIds = <String>{};
  Object? _runMonitorToken;
  String? _runLifecycleStatus;
  String? runId;
  String? status;
  bool sending = false;
  bool canceling = false;
  bool transcribing = false;
  bool queuePaused = false;
  bool promptQueueSyncing = false;
  Object? promptQueueError;
  bool artifactLoading = false;
  Object? artifactError;
  TalkMediaArtifactSummary? selectedArtifact;
  TalkArtifactContent? selectedArtifactContent;
  Object? voiceError;
  TalkAssignedAgent? assignedAgent;
  bool _disposed = false;
  bool _drainingQueue = false;
  int _promptSequence = 0;

  TalkPromptQueueRepository? get _promptQueueRepository =>
      repository is TalkPromptQueueRepository
      ? repository as TalkPromptQueueRepository
      : null;

  TalkCommandContextRepository? get _commandContextRepository =>
      repository is TalkCommandContextRepository
      ? repository as TalkCommandContextRepository
      : null;

  TalkCommandModelSelectionRepository? get _commandModelRepository =>
      repository is TalkCommandModelSelectionRepository
      ? repository as TalkCommandModelSelectionRepository
      : null;

  Future<TalkCommandContextCatalog> loadCommandContextCatalog() async {
    final contextRepository = _commandContextRepository;
    if (contextRepository == null) {
      throw StateError('Command context is not available in this Asael build.');
    }
    return contextRepository.loadCommandContextCatalog();
  }

  Future<TalkCommandModelCatalog> loadCommandModelCatalog({
    required String commandScope,
  }) async {
    final modelRepository = _commandModelRepository;
    if (modelRepository == null) {
      throw StateError('Model choices are not available in this Asael build.');
    }
    return modelRepository.loadCommandModelCatalog(commandScope: commandScope);
  }

  List<String> get workflowIds => List.unmodifiable(_workflowIds);
  Set<String> get monitoringWorkflowIds =>
      Set.unmodifiable(_workflowMonitorTokens.keys);
  bool get monitoringAcceptedRun => _runMonitorToken != null;
  bool get waitingForApproval => _runLifecycleStatus == 'waiting_approval';
  String? get pendingApprovalRoute {
    for (final activity in activities.reversed) {
      if (activity.key.startsWith('approval:') &&
          activity.state == TalkActivityState.waiting &&
          activity.actionRoute != null) {
        return activity.actionRoute;
      }
    }
    return null;
  }

  bool get hasPendingConversationWork =>
      sending ||
      (runId != null && !_acceptedRunIsTerminal) ||
      promptQueue.isNotEmpty;

  String? get voiceErrorMessage {
    final error = voiceError;
    if (error == null) return null;
    if (error is ApiException) {
      final message = _boundedDisplayText(error.message, 320);
      final diagnostic = '${error.diagnosticCode ?? ''} $message'.toLowerCase();
      if (error.statusCode == 401 || error.statusCode == 403) {
        return 'Voice transcription needs attention in Settings. Check the connected provider, then try again.';
      }
      if (error.statusCode == 413) {
        return 'That recording is too long to transcribe. Try a shorter voice draft.';
      }
      if (error.statusCode == 429) {
        return 'The voice service is busy or has reached its limit. Wait a moment, then try again.';
      }
      if (diagnostic.contains('connection') ||
          diagnostic.contains('timeout') ||
          diagnostic.contains('network')) {
        return 'Asael could not reach the voice service. Check your connection, then try again.';
      }
      if ((diagnostic.contains('transcri') || diagnostic.contains('audio')) &&
          (diagnostic.contains('config') ||
              diagnostic.contains('model') ||
              diagnostic.contains('provider'))) {
        return 'Voice transcription is not configured yet. Choose a transcription model in Settings, then try again.';
      }
      if (message.isNotEmpty) return message;
    }
    if (error is StateError) {
      final message = _boundedDisplayText(error.message, 320);
      if (message.toLowerCase().contains('transcribable speech')) {
        return 'No clear speech was detected. Move closer to the microphone and record again.';
      }
      if (message.isNotEmpty) return message;
    }
    if (error is FormatException) {
      return 'The voice service returned a response Asael could not read. Record again, or check the transcription model in Settings.';
    }
    return 'Voice transcription did not finish. Your typed draft is safe, so you can record again.';
  }

  void clearVoiceError() {
    if (voiceError == null) return;
    voiceError = null;
    notifyListeners();
  }

  void assignAgent({required String id, required String name}) {
    final exactId = id.trim();
    final exactName = name.trim();
    if (!RegExp(r'^[a-zA-Z0-9_.:-]{1,120}$').hasMatch(exactId) ||
        exactName.isEmpty ||
        exactName.length > 160) {
      throw ArgumentError('The selected Agent identity is invalid.');
    }
    assignedAgent = TalkAssignedAgent(id: exactId, name: exactName);
    notifyListeners();
  }

  void clearAssignedAgent() {
    if (assignedAgent == null) return;
    assignedAgent = null;
    notifyListeners();
  }

  @override
  TalkHistoryRepository? get talkHistoryRepository =>
      repository is TalkHistoryRepository
      ? repository as TalkHistoryRepository
      : null;

  @override
  bool get historyInteractionBusy => hasPendingConversationWork;

  @override
  void applyHistoryThreadProjection(TalkThreadDetail detail) {
    _abandonAcceptedRun();
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
    queuePaused = _allActivePromptsPaused(promptQueue);
    _workflowIds.clear();
    _workflowMonitorTokens.clear();
    _retryInput = null;
    _retryMode = null;
    _retryStrategy = null;
    _retryExecutionTarget = null;
    _retryAssignedAgent = null;
    _retryContextReferences = const [];
    _retryModelSelection = null;
    status = null;
    canceling = false;
  }

  @override
  void clearHistoryThreadProjection() {
    _abandonAcceptedRun();
    messages.clear();
    activities.clear();
    _clearArtifacts();
    queuePaused = _allActivePromptsPaused(promptQueue);
    _workflowIds.clear();
    _workflowMonitorTokens.clear();
    _retryInput = null;
    _retryMode = null;
    _retryStrategy = null;
    _retryExecutionTarget = null;
    _retryAssignedAgent = null;
    _retryContextReferences = const [];
    _retryModelSelection = null;
    status = null;
  }

  Future<void> send(
    String input, {
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    List<TalkCommandContextReference> contextReferences = const [],
    TalkCommandModelSelection? modelSelection,
  }) async {
    final text = input.trim();
    if (_disposed || text.isEmpty) return;
    final targetAgent = assignedAgent;
    if (sending) {
      enqueuePrompt(
        text,
        mode: mode,
        strategy: targetAgent == null && modelSelection == null
            ? strategy
            : 'direct',
        executionTarget: executionTarget,
        assignedAgent: targetAgent,
        contextReferences: contextReferences,
        modelSelection: modelSelection,
      );
      return;
    }
    queuePaused = false;
    return _send(
      input,
      mode: mode,
      strategy: targetAgent == null ? strategy : 'direct',
      executionTarget: executionTarget,
      assignedAgent: targetAgent,
      contextReferences: contextReferences,
      modelSelection: modelSelection,
    );
  }

  void enqueuePrompt(
    String input, {
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    TalkAssignedAgent? assignedAgent,
    List<TalkCommandContextReference> contextReferences = const [],
    TalkCommandModelSelection? modelSelection,
  }) {
    final text = input.trim();
    if (_disposed ||
        text.isEmpty ||
        text.length > 20000 ||
        promptQueue.length >= 40) {
      return;
    }
    final correlationId =
        'flutter-${DateTime.now().microsecondsSinceEpoch}-${_promptSequence++}';
    final prompt = TalkQueuedPrompt(
      id: 'local-$correlationId',
      clientCorrelationId: correlationId,
      input: text,
      mode: mode,
      strategy: strategy,
      executionTarget: executionTarget,
      assignedAgent: assignedAgent ?? this.assignedAgent,
      threadId: threadId,
      contextReferences: List.unmodifiable(contextReferences),
      modelSelection: modelSelection,
      syncState: _promptQueueRepository == null
          ? TalkPromptQueueSyncState.synced
          : TalkPromptQueueSyncState.pending,
    );
    promptQueue.add(prompt);
    notifyListeners();
    final queueRepository = _promptQueueRepository;
    if (queueRepository != null) {
      unawaited(_createPromptQueueItem(queueRepository, prompt));
    }
  }

  void updateQueuedPrompt(String id, String input) {
    final text = input.trim();
    if (text.isEmpty || text.length > 20000) return;
    final index = promptQueue.indexWhere((item) => item.id == id);
    if (index < 0) return;
    final current = promptQueue[index];
    if (!current.editable) return;
    promptQueue[index] = current.copyWith(
      input: text,
      lifecycleRevision: current.lifecycleRevision + 1,
      state: current.state == 'failed' ? 'queued' : current.state,
      syncState: _promptQueueRepository == null
          ? TalkPromptQueueSyncState.synced
          : TalkPromptQueueSyncState.pending,
    );
    notifyListeners();
    final queueRepository = _promptQueueRepository;
    if (queueRepository != null) {
      unawaited(_updatePromptQueueItem(queueRepository, current, input: text));
    }
  }

  void removeQueuedPrompt(String id) {
    final index = promptQueue.indexWhere((item) => item.id == id);
    if (index < 0) return;
    if (!const {
      'queued',
      'paused',
      'failed',
      'completed',
    }.contains(promptQueue[index].state)) {
      return;
    }
    final removed = promptQueue.removeAt(index);
    notifyListeners();
    final queueRepository = _promptQueueRepository;
    if (queueRepository != null) {
      unawaited(_deletePromptQueueItem(queueRepository, removed));
    }
  }

  void moveQueuedPrompt(String id, int offset) {
    final index = promptQueue.indexWhere((item) => item.id == id);
    final next = index + offset;
    if (index < 0 || next < 0 || next >= promptQueue.length) return;
    if (!const {'queued', 'paused'}.contains(promptQueue[index].state) ||
        !const {'queued', 'paused'}.contains(promptQueue[next].state)) {
      return;
    }
    final item = promptQueue.removeAt(index);
    promptQueue.insert(next, item);
    notifyListeners();
    final queueRepository = _promptQueueRepository;
    if (queueRepository != null) {
      unawaited(_reorderPromptQueue(queueRepository));
    }
  }

  void pauseQueue() {
    if (queuePaused) return;
    queuePaused = true;
    notifyListeners();
    final queueRepository = _promptQueueRepository;
    if (queueRepository != null) {
      for (final prompt in List<TalkQueuedPrompt>.from(promptQueue)) {
        if (prompt.state == 'queued') {
          unawaited(
            _updatePromptQueueItem(queueRepository, prompt, state: 'paused'),
          );
        }
      }
    }
  }

  void setQueuedPromptPaused(String id, {required bool paused}) {
    final index = promptQueue.indexWhere((item) => item.id == id);
    if (index < 0) return;
    final current = promptQueue[index];
    final nextState = paused ? 'paused' : 'queued';
    if ((paused && current.state != 'queued') ||
        (!paused && current.state != 'paused' && current.state != 'failed')) {
      return;
    }
    promptQueue[index] = current.copyWith(
      state: nextState,
      lifecycleRevision: current.lifecycleRevision + 1,
      syncState: _promptQueueRepository == null
          ? TalkPromptQueueSyncState.synced
          : TalkPromptQueueSyncState.pending,
    );
    queuePaused = _allActivePromptsPaused(promptQueue);
    notifyListeners();
    final queueRepository = _promptQueueRepository;
    if (queueRepository != null) {
      unawaited(
        _updatePromptQueueItem(queueRepository, current, state: nextState),
      );
    } else if (!paused) {
      unawaited(_drainPromptQueue());
    }
  }

  void resumeQueue() {
    if (!queuePaused && (sending || promptQueue.isEmpty)) return;
    queuePaused = false;
    notifyListeners();
    final queueRepository = _promptQueueRepository;
    if (queueRepository != null) {
      for (final prompt in List<TalkQueuedPrompt>.from(promptQueue)) {
        if (prompt.state == 'paused' || prompt.state == 'failed') {
          unawaited(
            _updatePromptQueueItem(queueRepository, prompt, state: 'queued'),
          );
        }
      }
    }
    unawaited(_drainPromptQueue());
  }

  Future<void> runQueuedPrompt(String id) async {
    final index = promptQueue.indexWhere((item) => item.id == id);
    if (index < 0) return;
    if (!const {'queued', 'paused'}.contains(promptQueue[index].state)) return;
    if (sending) {
      if (index > 0) {
        final item = promptQueue.removeAt(index);
        promptQueue.insert(0, item);
        notifyListeners();
      }
      return;
    }
    final queueRepository = _promptQueueRepository;
    if (queueRepository != null) {
      var item = promptQueue[index];
      if (!item.serverBacked) {
        await reconcilePromptQueue();
        final correlationId = item.clientCorrelationId;
        final reconciledIndex = promptQueue.indexWhere(
          (candidate) =>
              candidate.clientCorrelationId == correlationId &&
              candidate.serverBacked,
        );
        if (reconciledIndex < 0) return;
        item = promptQueue[reconciledIndex];
      }
      queuePaused = false;
      await _send(
        item.input,
        mode: item.mode,
        strategy: item.strategy,
        executionTarget: item.executionTarget,
        assignedAgent: item.assignedAgent,
        contextReferences: item.contextReferences,
        modelSelection: item.modelSelection,
        queuedPrompt: item,
      );
      await reconcilePromptQueue();
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
      assignedAgent: item.assignedAgent,
      contextReferences: item.contextReferences,
      modelSelection: item.modelSelection,
    );
  }

  Future<void> initializePromptQueue() async {
    final queueRepository = _promptQueueRepository;
    if (_disposed || queueRepository == null || promptQueueSyncing) return;
    promptQueueSyncing = true;
    promptQueueError = null;
    notifyListeners();
    try {
      _replacePromptQueue(await queueRepository.listPromptQueue());
    } catch (error) {
      promptQueueError = error;
    } finally {
      promptQueueSyncing = false;
      if (!_disposed) notifyListeners();
    }
  }

  Future<void> reconcilePromptQueue() async {
    final queueRepository = _promptQueueRepository;
    if (_disposed || queueRepository == null || promptQueueSyncing) return;
    promptQueueSyncing = true;
    promptQueueError = null;
    notifyListeners();
    try {
      _replacePromptQueue(await queueRepository.reconcilePromptQueue());
    } catch (error) {
      promptQueueError = error;
    } finally {
      promptQueueSyncing = false;
      if (!_disposed) notifyListeners();
    }
  }

  Future<void> _createPromptQueueItem(
    TalkPromptQueueRepository queueRepository,
    TalkQueuedPrompt prompt,
  ) async {
    try {
      final created = await queueRepository.createPromptQueueItem(prompt);
      final index = promptQueue.indexWhere(
        (candidate) =>
            candidate.id == prompt.id ||
            candidate.clientCorrelationId == prompt.clientCorrelationId,
      );
      if (index >= 0) promptQueue[index] = created;
      promptQueueError = null;
    } catch (error) {
      promptQueueError = error;
      final index = promptQueue.indexWhere((item) => item.id == prompt.id);
      if (index >= 0) {
        promptQueue[index] = promptQueue[index].copyWith(
          syncState: TalkPromptQueueSyncState.conflict,
        );
      }
    }
    if (!_disposed) notifyListeners();
  }

  Future<void> _updatePromptQueueItem(
    TalkPromptQueueRepository queueRepository,
    TalkQueuedPrompt prompt, {
    String? input,
    String? state,
  }) async {
    try {
      final updated = await queueRepository.updatePromptQueueItem(
        prompt,
        input: input,
        state: state,
      );
      final index = promptQueue.indexWhere(
        (candidate) =>
            candidate.id == prompt.id ||
            candidate.clientCorrelationId == prompt.clientCorrelationId,
      );
      if (index >= 0) promptQueue[index] = updated;
      promptQueueError = null;
    } catch (error) {
      promptQueueError = error;
      final index = promptQueue.indexWhere((item) => item.id == prompt.id);
      if (index >= 0) {
        promptQueue[index] = promptQueue[index].copyWith(
          syncState: TalkPromptQueueSyncState.conflict,
        );
      }
    }
    if (!_disposed) notifyListeners();
  }

  Future<void> _deletePromptQueueItem(
    TalkPromptQueueRepository queueRepository,
    TalkQueuedPrompt prompt,
  ) async {
    try {
      await queueRepository.deletePromptQueueItem(prompt);
      promptQueueError = null;
    } catch (error) {
      promptQueueError = error;
      await reconcilePromptQueue();
    }
    if (!_disposed) notifyListeners();
  }

  Future<void> _reorderPromptQueue(
    TalkPromptQueueRepository queueRepository,
  ) async {
    try {
      final terminal = promptQueue
          .where((item) => item.state != 'queued' && item.state != 'paused')
          .toList(growable: false);
      _replacePromptQueue([
        ...await queueRepository.reorderPromptQueue(
          promptQueue
              .where((item) => item.state == 'queued' || item.state == 'paused')
              .toList(growable: false),
        ),
        ...terminal,
      ]);
      promptQueueError = null;
    } catch (error) {
      promptQueueError = error;
      await reconcilePromptQueue();
    }
    if (!_disposed) notifyListeners();
  }

  void _replacePromptQueue(List<TalkQueuedPrompt> next) {
    promptQueue
      ..clear()
      ..addAll(next.take(40));
    queuePaused = _allActivePromptsPaused(promptQueue);
  }

  Future<void> selectArtifact(TalkMediaArtifactSummary artifact) async {
    if (!artifacts.any((item) => item.identityKey == artifact.identityKey)) {
      return;
    }
    selectedArtifact = artifact;
    selectedArtifactContent = null;
    artifactError = null;
    final localPreview = _localPreviewContents[artifact.assetId];
    if (localPreview != null) {
      selectedArtifactContent = localPreview;
      artifactLoading = false;
      notifyListeners();
      return;
    }
    if (artifact.kind == 'computer' || artifact.kind == 'terminal') {
      // Historical remote-browser frames are no longer readable. Current
      // This Mac screenshots return through the in-memory preview map above
      // and never use the retired frame endpoint.
      artifactError = const LegacyComputerPreviewRetired();
      artifactLoading = false;
      notifyListeners();
      return;
    }
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
    for (final timer in _localPreviewExpiryTimers.values) {
      timer.cancel();
    }
    _localPreviewExpiryTimers.clear();
    final temporaryContents = _localPreviewContents.values.toList(
      growable: false,
    );
    artifacts.clear();
    _localPreviewArtifacts.clear();
    _localPreviewContents.clear();
    selectedArtifact = null;
    selectedArtifactContent = null;
    artifactError = null;
    artifactLoading = false;
    for (final content in temporaryContents) {
      if (content.terminal != null) continue;
      PaintingBinding.instance.imageCache.evict(
        MemoryImage(content.bytes),
        includeLive: true,
      );
    }
  }

  String? _retryInput;
  String? _retryMode;
  String? _retryStrategy;
  TalkExecutionTarget? _retryExecutionTarget;
  TalkAssignedAgent? _retryAssignedAgent;
  List<TalkCommandContextReference> _retryContextReferences = const [];
  TalkCommandModelSelection? _retryModelSelection;

  bool get canRetry => !sending && _retryInput != null;
  bool get _acceptedRunIsTerminal =>
      const {'completed', 'failed', 'canceled'}.contains(_runLifecycleStatus);

  void _clearRetry() {
    _retryInput = null;
    _retryMode = null;
    _retryStrategy = null;
    _retryExecutionTarget = null;
    _retryAssignedAgent = null;
    _retryContextReferences = const [];
    _retryModelSelection = null;
  }

  void _abandonAcceptedRun() {
    final abandonedRunId = runId;
    if (abandonedRunId != null) {
      localComputerPreviews?.discardRunPreviews(abandonedRunId);
    }
    _runMonitorToken = null;
    _runLifecycleStatus = null;
    runId = null;
  }

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
      assignedAgent: _retryAssignedAgent,
      contextReferences: _retryContextReferences,
      modelSelection: _retryModelSelection,
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
    TalkAssignedAgent? assignedAgent,
    List<TalkCommandContextReference> contextReferences = const [],
    TalkCommandModelSelection? modelSelection,
    TalkQueuedPrompt? queuedPrompt,
    bool queuedForce = true,
    bool replaceFailedResponse = false,
  }) async {
    final text = input.trim();
    if (_disposed || text.isEmpty || sending) return;
    activities.clear();
    _clearArtifacts();
    _abandonAcceptedRun();
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
    final pendingText = StringBuffer();
    Timer? textFlushTimer;

    void flushPendingText() {
      if (pendingText.length == 0) return;
      final delta = pendingText.toString();
      pendingText.clear();
      if (_disposed || messages.isEmpty) return;
      messages[messages.length - 1] = messages.last.copyWith(
        text: messages.last.text + delta,
      );
    }

    void scheduleTextFlush() {
      if (textFlushTimer?.isActive ?? false) return;
      textFlushTimer = Timer(const Duration(milliseconds: 32), () {
        textFlushTimer = null;
        if (_disposed) return;
        flushPendingText();
        notifyListeners();
      });
    }

    try {
      final queueRepository = _promptQueueRepository;
      final events = queuedPrompt != null && queueRepository != null
          ? queueRepository.dispatchPromptQueueItem(
              queuedPrompt,
              force: queuedForce,
            )
          : contextReferences.isNotEmpty
          ? (_commandContextRepository ??
                    (throw StateError(
                      'This Asael build cannot send selected Command context.',
                    )))
                .sendWithCommandContext(
                  message: text,
                  contextReferences: contextReferences,
                  threadId: threadId,
                  mode: mode,
                  strategy: strategy,
                  executionTarget: executionTarget,
                  agentId: assignedAgent?.id,
                  modelSelection: modelSelection,
                )
          : repository.send(
              message: text,
              threadId: threadId,
              mode: mode,
              strategy: strategy,
              executionTarget: executionTarget,
              agentId: assignedAgent?.id,
              modelSelection: modelSelection,
            );
      await for (final event in events) {
        if (_disposed) return;
        adoptConversationThreadId(event.data['threadId']);
        if (event.event != 'delta') {
          textFlushTimer?.cancel();
          textFlushTimer = null;
          flushPendingText();
        }
        switch (event.event) {
          case 'run':
            final acceptedRunId = safeTalkHistoryId(event.data['runId']);
            if (acceptedRunId.isEmpty) {
              throw const FormatException(
                'The governed run identity was invalid.',
              );
            }
            runId = acceptedRunId;
            _runLifecycleStatus = 'running';
            _clearRetry();
            _recordActivity(
              key: 'run',
              title: 'Main agent',
              detail: 'Started a governed run.',
              state: TalkActivityState.active,
            );
          case 'delta':
            final delta = event.data['text'] as String? ?? '';
            if (delta.isNotEmpty) {
              pendingText.write(delta);
              scheduleTextFlush();
            }
            continue;
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
            final thinking = _modelThinkingLabel(event.data['reasoningEffort']);
            _recordActivity(
              key: 'model:${event.data['iteration'] ?? activities.length}',
              title: 'Model response',
              detail:
                  '$provider · $model${thinking == null ? '' : ' · $thinking thinking'} · $tokens tokens · ${latency}ms',
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
            final toolId = event.data['toolId']?.toString() ?? '';
            final executionId = _boundedDisplayText(
              event.data['executionId'],
              240,
            );
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
            if (toolStatus == 'executed' &&
                (toolId == 'local.macos.observe' ||
                    toolId == 'local.macos.command.run') &&
                executionId.isNotEmpty) {
              final acceptedRunId = runId;
              if (acceptedRunId != null) {
                _attachLocalComputerPreviews(
                  acceptedRunId,
                  executionId: executionId,
                );
              }
            }
          case 'clarification':
            _runLifecycleStatus = 'waiting_clarification';
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
            _runLifecycleStatus = 'completed';
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
            final completedRunId = runId;
            if (completedRunId != null) {
              _attachLocalComputerPreviews(completedRunId);
            }
          case 'waiting_approval':
            _runLifecycleStatus = 'waiting_approval';
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
            _runLifecycleStatus = null;
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
            _runLifecycleStatus = 'canceled';
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
            _runLifecycleStatus = 'failed';
            final message =
                event.data['message'] as String? ?? 'The governed run failed.';
            messages[messages.length - 1] = messages.last.copyWith(
              text: message,
              streaming: false,
              failed: true,
            );
            status = null;
            queuePaused = true;
            _clearRetry();
            _recordActivity(
              key: 'run',
              title: 'Main agent',
              detail: message,
              state: TalkActivityState.failed,
            );
        }
        notifyListeners();
      }
      if (_disposed) return;
      textFlushTimer?.cancel();
      textFlushTimer = null;
      flushPendingText();
      _clearRetry();
    } catch (error) {
      if (_disposed) return;
      textFlushTimer?.cancel();
      textFlushTimer = null;
      flushPendingText();
      final acceptedRunId = runId;
      if (acceptedRunId != null) {
        queuePaused = true;
        final current = messages.last.text;
        messages[messages.length - 1] = messages.last.copyWith(
          text: current.isEmpty
              ? 'Asael is reconnecting to this governed run.'
              : current,
          streaming: false,
          failed: false,
        );
        _clearRetry();
        _recordActivity(
          key: 'run',
          title: 'Main agent',
          detail: 'The live view disconnected. Following the accepted run without sending it again.',
          state: TalkActivityState.active,
        );
      } else {
        final failure = _talkFailure(error);
        queuePaused = true;
        messages[messages.length - 1] = messages.last.copyWith(
          text: messages.last.text.isEmpty
              ? failure.message
              : messages.last.text,
          streaming: false,
          failed: true,
        );
        _retryInput = text;
        _retryMode = mode;
        _retryStrategy = strategy;
        _retryExecutionTarget = executionTarget;
        _retryAssignedAgent = assignedAgent;
        _retryContextReferences = List.unmodifiable(contextReferences);
        _retryModelSelection = modelSelection;
        _recordActivity(
          key: 'run',
          title: 'Main agent',
          detail: failure.detail,
          state: TalkActivityState.failed,
        );
      }
    } finally {
      textFlushTimer?.cancel();
      flushPendingText();
      sending = false;
      status = null;
      if (!_disposed) notifyListeners();
    }
    if (_disposed) return;
    if (terminalInspectionRunId case final id?) {
      await _inspectTerminalRun(id);
    } else if (runId != null && !_acceptedRunIsTerminal) {
      reconcileAcceptedRun();
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
      final queueRepository = _promptQueueRepository;
      if (queueRepository != null) {
        while (!_disposed && !sending && !queuePaused) {
          final next = promptQueue
              .where((item) => item.state == 'queued' && item.serverBacked)
              .firstOrNull;
          if (next == null) break;
          await _send(
            next.input,
            mode: next.mode,
            strategy: next.strategy,
            executionTarget: next.executionTarget,
            assignedAgent: next.assignedAgent,
            contextReferences: next.contextReferences,
            modelSelection: next.modelSelection,
            queuedPrompt: next,
            queuedForce: false,
          );
          await reconcilePromptQueue();
          if (promptQueue.any(
            (item) => item.id == next.id && item.state == 'queued',
          )) {
            break;
          }
        }
        return;
      }
      while (!_disposed && !sending && !queuePaused && promptQueue.isNotEmpty) {
        final next = promptQueue.removeAt(0);
        notifyListeners();
        await _send(
          next.input,
          mode: next.mode,
          strategy: next.strategy,
          executionTarget: next.executionTarget,
          assignedAgent: next.assignedAgent,
          contextReferences: next.contextReferences,
          modelSelection: next.modelSelection,
        );
      }
    } finally {
      _drainingQueue = false;
    }
  }

  /// Re-enters the exact accepted run through its actor-private read surface.
  /// This is safe to call on reconnect, app focus, and Conversation re-entry;
  /// a current monitor is reused and no command submission is repeated.
  void reconcileAcceptedRun() {
    final id = runId;
    if (_disposed ||
        sending ||
        id == null ||
        _acceptedRunIsTerminal ||
        _runMonitorToken != null) {
      return;
    }
    final token = Object();
    _runMonitorToken = token;
    unawaited(_monitorAcceptedRun(id, token));
  }

  Future<void> _monitorAcceptedRun(String id, Object token) async {
    var receivedProjection = false;
    for (var attempt = 0; attempt < runRecoveryPollLimit; attempt += 1) {
      if (attempt > 0 && runRecoveryPollInterval > Duration.zero) {
        await Future<void>.delayed(runRecoveryPollInterval);
      }
      if (!_runMonitorIsCurrent(id, token)) return;
      try {
        final inspection = await repository.inspectRun(id);
        if (!_runMonitorIsCurrent(id, token)) return;
        if (inspection.runId != id) {
          throw const FormatException('Run identity did not match.');
        }
        receivedProjection = true;
        _applyRecoveredRun(inspection);
        _attachLocalComputerPreviews(id);
        if (!_disposed) notifyListeners();
        if (inspection.terminal) {
          _runMonitorToken = null;
          _inspectedRunIds.add(id);
          _projectTerminalRunEvidence(inspection);
          if (!_disposed) {
            notifyListeners();
            if (conversationHistorySupported) {
              unawaited(loadRecentThreads(force: true));
            }
            unawaited(_drainPromptQueue());
          }
          return;
        }
      } catch (_) {
        if (!_runMonitorIsCurrent(id, token)) return;
        _recordActivity(
          key: 'run-recovery:$id',
          title: receivedProjection
              ? 'Keeping this run in sync'
              : 'Reconnecting to this run',
          detail: 'The next bounded status check will follow the same accepted run.',
          state: TalkActivityState.active,
        );
        if (!_disposed) notifyListeners();
      }
    }
    if (!_runMonitorIsCurrent(id, token)) return;
    _runMonitorToken = null;
    _recordActivity(
      key: 'run-recovery:$id',
      title: 'This run is still in progress',
      detail: 'Asael will check this accepted run again after reconnect, app focus, or Conversation re-entry.',
      state: TalkActivityState.waiting,
    );
    if (!_disposed) notifyListeners();
  }

  bool _runMonitorIsCurrent(String id, Object token) =>
      !_disposed && runId == id && identical(_runMonitorToken, token);

  void _applyRecoveredRun(TalkRunInspection inspection) {
    _runLifecycleStatus = inspection.status;
    adoptConversationThreadId(inspection.threadId);
    _clearRetry();
    switch (inspection.status) {
      case 'queued':
        status = 'Queued';
        _recordActivity(
          key: 'run',
          title: 'Main agent',
          detail: 'The accepted run is queued.',
          state: TalkActivityState.active,
        );
      case 'running':
        status = 'Working';
        _recordActivity(
          key: 'run',
          title: 'Main agent',
          detail: 'The accepted governed run is in progress.',
          state: TalkActivityState.active,
        );
      case 'resuming':
        status = 'Resuming';
        _resolveWaitingApprovalActivity();
        _recordActivity(
          key: 'run',
          title: 'Main agent',
          detail: 'Approval was recorded. The same governed run is resuming.',
          state: TalkActivityState.active,
        );
      case 'waiting_approval':
        queuePaused = true;
        status = 'Waiting for approval';
        final approval = inspection.waitingApproval;
        final message =
            inspection.response ??
            '${approval?.toolName ?? 'A governed action'} needs approval before the task can continue.';
        _replaceCurrentAssistantWhenRecovering(message);
        _recordActivity(
          key: 'approval:${approval?.executionId ?? 'pending'}',
          title: 'Approval required',
          detail: message,
          state: TalkActivityState.waiting,
          actionLabel: 'Review approval',
          actionRoute: approval == null
              ? '/inbox'
              : '/inbox/approvals/${Uri.encodeComponent(approval.executionId)}',
        );
      case 'waiting_clarification':
        queuePaused = true;
        status = 'Needs your input';
        final message =
            inspection.response ??
            'Asael needs one detail before this run can continue.';
        _replaceCurrentAssistantWhenRecovering(message);
        _recordActivity(
          key: 'clarification',
          title: 'Clarification needed',
          detail: message,
          state: TalkActivityState.waiting,
        );
      case 'completed':
        queuePaused = false;
        status = null;
        _replaceCurrentAssistant(
          inspection.response ?? 'The governed run completed.',
        );
        _resolveWaitingApprovalActivity();
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
      case 'failed':
        queuePaused = true;
        status = null;
        final message = inspection.error ?? 'The governed run failed.';
        _replaceCurrentAssistant(message, failed: true);
        _recordActivity(
          key: 'run',
          title: 'Main agent',
          detail: message,
          state: TalkActivityState.failed,
        );
      case 'canceled':
        queuePaused = true;
        status = null;
        final message = inspection.error ?? 'The governed run was canceled.';
        _replaceCurrentAssistant(message, failed: true);
        _recordActivity(
          key: 'run',
          title: 'Main agent',
          detail: message,
          state: TalkActivityState.failed,
        );
    }
  }

  void _replaceCurrentAssistantWhenRecovering(String text) {
    final current = messages.lastOrNull;
    if (current == null || current.role != TalkRole.assistant) return;
    if (current.text.isNotEmpty &&
        current.text != 'Asael is reconnecting to this governed run.') {
      return;
    }
    _replaceCurrentAssistant(text);
  }

  void _replaceCurrentAssistant(String text, {bool failed = false}) {
    final current = messages.lastOrNull;
    if (current == null || current.role != TalkRole.assistant) return;
    messages[messages.length - 1] = current.copyWith(
      text: text,
      streaming: false,
      failed: failed,
    );
  }

  void _resolveWaitingApprovalActivity() {
    for (var index = 0; index < activities.length; index += 1) {
      final activity = activities[index];
      if (!activity.key.startsWith('approval:') ||
          activity.state != TalkActivityState.waiting) {
        continue;
      }
      activities[index] = TalkActivity(
        key: activity.key,
        title: 'Approval resolved',
        detail: 'The original governed run continued.',
        state: TalkActivityState.succeeded,
      );
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
    try {
      final inspection = await repository.inspectRun(id);
      if (_disposed) return;
      if (inspection.runId != id) {
        throw const FormatException('Run identity did not match.');
      }
      _projectTerminalRunEvidence(inspection);
      _attachLocalComputerPreviews(id);
    } catch (_) {
      if (_disposed) return;
      _recordActivity(
        key: 'evidence:$id',
        title: 'Run evidence available in Results',
        detail: 'The compact evidence summary could not refresh.',
        state: TalkActivityState.info,
        actionLabel: 'Open result',
        actionRoute: _resultRoute('agent', id),
      );
    }
    if (!_disposed) notifyListeners();
  }

  void _projectTerminalRunEvidence(TalkRunInspection inspection) {
    final route = _resultRoute('agent', inspection.runId);
    _projectAgentIdentity(inspection, route);
    _projectGrounding(inspection, route);
    _projectMediaArtifacts(inspection, route);
    _projectFileArtifacts(inspection, route);
    _projectWorkspaceArtifacts(inspection, route);
    artifacts
      ..clear()
      ..addAll(inspection.fileArtifacts)
      ..addAll(inspection.mediaArtifacts)
      ..addAll(_localPreviewArtifacts);
    if (artifacts.isEmpty) {
      selectedArtifact = null;
      selectedArtifactContent = null;
      artifactError = null;
    } else if (_localPreviewArtifacts.isNotEmpty) {
      _selectLocalPreview(_localPreviewArtifacts.last);
    } else {
      unawaited(selectArtifact(artifacts.first));
    }
  }

  void _attachLocalComputerPreviews(
    String expectedRunId, {
    String? executionId,
  }) {
    final source = localComputerPreviews;
    if (source == null) return;
    final LocalComputerTerminalPreviewSource? terminalSource =
        source is LocalComputerTerminalPreviewSource
        ? source as LocalComputerTerminalPreviewSource
        : null;
    final screenshotPreviews = <LocalComputerScreenshotPreview>[];
    final terminalPreviews = <LocalComputerTerminalPreview>[];
    if (executionId == null) {
      screenshotPreviews.addAll(source.takeRunPreviews(expectedRunId));
      if (terminalSource != null) {
        terminalPreviews.addAll(
          terminalSource.takeRunTerminalPreviews(expectedRunId),
        );
      }
    } else {
      final screenshot = source.takePreview(expectedRunId, executionId);
      if (screenshot != null) screenshotPreviews.add(screenshot);
      final terminal = terminalSource?.takeTerminalPreview(
        expectedRunId,
        executionId,
      );
      if (terminal != null) terminalPreviews.add(terminal);
    }
    var screenshotsAttached = 0;
    for (final preview in screenshotPreviews) {
      if (preview.runId != expectedRunId ||
          !preview.expiresAt.isAfter(DateTime.now().toUtc())) {
        continue;
      }
      final assetId = 'local_preview_${preview.executionId}';
      final extension = switch (preview.mediaType) {
        'image/png' => 'png',
        'image/webp' => 'webp',
        _ => 'jpg',
      };
      final artifact = TalkMediaArtifactSummary(
        assetId: assetId,
        kind: 'computer',
        operation: 'local_macos_observe',
        filename: 'this-mac-screenshot.$extension',
        mediaType: preview.mediaType,
        byteCount: preview.bytes.length,
        status: 'temporary',
        sourceRunId: expectedRunId,
        contextLabel: preview.applicationName == null
            ? 'Temporary preview · This Mac'
            : 'Temporary preview · ${preview.applicationName}',
      );
      _localPreviewArtifacts.removeWhere(
        (candidate) => candidate.assetId == assetId,
      );
      _localPreviewArtifacts.add(artifact);
      _localPreviewContents[assetId] = TalkArtifactContent(
        assetId: assetId,
        bytes: Uint8List.fromList(preview.bytes),
      );
      artifacts.removeWhere((candidate) => candidate.assetId == assetId);
      artifacts.add(artifact);
      _selectLocalPreview(artifact);
      _scheduleLocalPreviewExpiry(assetId, preview.expiresAt);
      screenshotsAttached += 1;
    }
    if (screenshotsAttached > 0) {
      _recordActivity(
        key: 'local-computer-preview:$expectedRunId',
        title: screenshotsAttached == 1
            ? 'Screenshot ready'
            : '$screenshotsAttached screenshots ready',
        detail: 'Private previews are available only in this app session and are not kept in Conversation history.',
        state: TalkActivityState.succeeded,
      );
    }

    for (final preview in terminalPreviews) {
      if (preview.runId != expectedRunId ||
          !preview.expiresAt.isAfter(DateTime.now().toUtc())) {
        continue;
      }
      final assetId = 'local_terminal_${preview.executionId}';
      final bytes = Uint8List.fromList(
        utf8.encode(_terminalExportText(preview)),
      );
      final artifact = TalkMediaArtifactSummary(
        assetId: assetId,
        kind: 'terminal',
        operation: 'local_macos_command',
        filename: '${preview.executable}-output.txt',
        mediaType: 'text/plain; charset=utf-8',
        byteCount: bytes.length,
        status: 'temporary',
        sourceRunId: expectedRunId,
        contextLabel:
            '${preview.workspaceName} · exit ${preview.output.exitCode}',
        title: '${preview.executable} output',
      );
      _localPreviewArtifacts.removeWhere(
        (candidate) => candidate.assetId == assetId,
      );
      _localPreviewArtifacts.add(artifact);
      _localPreviewContents[assetId] = TalkArtifactContent(
        assetId: assetId,
        bytes: bytes,
        terminal: preview,
      );
      artifacts.removeWhere((candidate) => candidate.assetId == assetId);
      artifacts.add(artifact);
      _selectLocalPreview(artifact);
      _scheduleLocalPreviewExpiry(assetId, preview.expiresAt);
      _recordActivity(
        key: 'local-command-output:${preview.executionId}',
        title: 'Command finished',
        detail:
            'Exit ${preview.output.exitCode} · ${_terminalDuration(preview.output.durationMs)} · temporary output attached',
        state: preview.output.exitCode == 0
            ? TalkActivityState.succeeded
            : TalkActivityState.failed,
      );
    }
  }

  static String _terminalExportText(LocalComputerTerminalPreview preview) {
    final output = preview.output;
    final folder = preview.relativeDirectory == '.'
        ? preview.workspaceName
        : '${preview.workspaceName}/${preview.relativeDirectory}';
    final buffer = StringBuffer()
      ..writeln('Command: ${preview.commandLabel}')
      ..writeln('Folder: $folder')
      ..writeln('Exit status: ${output.exitCode}')
      ..writeln('Duration: ${_terminalDuration(output.durationMs)}')
      ..writeln()
      ..writeln('STDOUT')
      ..writeln(output.stdout.isEmpty ? '(no output)' : output.stdout);
    if (output.stdoutTruncated) {
      buffer.writeln('[Output was shortened for this temporary preview.]');
    }
    buffer
      ..writeln()
      ..writeln('STDERR')
      ..writeln(output.stderr.isEmpty ? '(no errors)' : output.stderr);
    if (output.stderrTruncated) {
      buffer.writeln(
        '[Error output was shortened for this temporary preview.]',
      );
    }
    return buffer.toString();
  }

  static String _terminalDuration(int milliseconds) {
    if (milliseconds < 1000) return '${milliseconds}ms';
    return '${(milliseconds / 1000).toStringAsFixed(1)}s';
  }

  void _selectLocalPreview(TalkMediaArtifactSummary artifact) {
    selectedArtifact = artifact;
    selectedArtifactContent = _localPreviewContents[artifact.assetId];
    artifactLoading = false;
    artifactError = null;
  }

  void _scheduleLocalPreviewExpiry(String assetId, DateTime expiresAt) {
    _localPreviewExpiryTimers.remove(assetId)?.cancel();
    final remaining = expiresAt.toUtc().difference(DateTime.now().toUtc());
    if (remaining <= Duration.zero) {
      _removeLocalPreview(assetId);
      return;
    }
    _localPreviewExpiryTimers[assetId] = Timer(remaining, () {
      _localPreviewExpiryTimers.remove(assetId);
      _removeLocalPreview(assetId);
      if (!_disposed) notifyListeners();
    });
  }

  void _removeLocalPreview(String assetId) {
    _localPreviewArtifacts.removeWhere(
      (candidate) => candidate.assetId == assetId,
    );
    final content = _localPreviewContents.remove(assetId);
    artifacts.removeWhere((candidate) => candidate.assetId == assetId);
    if (selectedArtifact?.assetId == assetId) {
      selectedArtifact = null;
      selectedArtifactContent = null;
      artifactLoading = false;
      artifactError = null;
    }
    if (content != null && content.terminal == null) {
      PaintingBinding.instance.imageCache.evict(
        MemoryImage(content.bytes),
        includeLive: true,
      );
    }
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

  void _projectFileArtifacts(TalkRunInspection inspection, String route) {
    for (final artifact in inspection.fileArtifacts.take(8)) {
      final slides = artifact.slideCount == null
          ? 'PowerPoint presentation'
          : '${artifact.slideCount} slide${artifact.slideCount == 1 ? '' : 's'}';
      _recordActivity(
        key: 'artifact:${artifact.identityKey}',
        title: 'Presentation ready',
        detail:
            '${artifact.title ?? artifact.filename} · $slides · ${_humanBytes(artifact.byteCount)} · Private',
        state: TalkActivityState.succeeded,
        actionLabel: 'Open result',
        actionRoute: route,
      );
    }
    final remaining = inspection.fileArtifacts.length - 8;
    if (remaining > 0) {
      _recordActivity(
        key: 'artifact-more:${inspection.runId}',
        title: '$remaining more generated files',
        detail: 'Open the result to inspect the complete bounded projection.',
        state: TalkActivityState.info,
        actionLabel: 'Open result',
        actionRoute: route,
      );
    }
  }

  void _projectWorkspaceArtifacts(TalkRunInspection inspection, String route) {
    for (final artifact in inspection.workspaceArtifacts.take(8)) {
      _recordActivity(
        key: 'workspace-artifact:${artifact.resourceId}',
        title: '${artifact.typeLabel} ready',
        detail: '${artifact.title} · Collaborative · Google Workspace',
        state: TalkActivityState.succeeded,
        actionLabel: 'Open in Google',
        externalUri: artifact.editorUri,
      );
    }
    final remaining = inspection.workspaceArtifacts.length - 8;
    if (remaining > 0) {
      _recordActivity(
        key: 'workspace-artifact-more:${inspection.runId}',
        title: '$remaining more Google Workspace files',
        detail: 'Open the result to inspect the complete verified projection.',
        state: TalkActivityState.info,
        actionLabel: 'Open result',
        actionRoute: route,
      );
    }
    if (inspection.workspaceArtifactState == 'unavailable') {
      _recordActivity(
        key: 'workspace-artifact-unavailable:${inspection.runId}',
        title: 'Google Workspace link unavailable',
        detail: 'The run remains intact. Open Results later to retry its verified file projection.',
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
    Uri? externalUri,
  }) {
    final activity = TalkActivity(
      key: key,
      title: title,
      detail: detail,
      state: state,
      actionLabel: actionLabel,
      actionRoute: actionRoute,
      externalUri: externalUri,
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

  static String? _modelThinkingLabel(Object? value) => switch (value) {
    'minimal' => 'Minimal',
    'low' => 'Low',
    'medium' => 'Medium',
    'high' => 'High',
    'xhigh' => 'Extra high',
    'max' => 'Ultra',
    _ => null,
  };

  static String _countDetail(Object? value, String label) {
    final count = value is int ? value : 1;
    return '$count $label${count == 1 ? '' : 's'}';
  }

  @override
  void dispose() {
    _disposed = true;
    final activeRunId = runId;
    if (activeRunId != null) {
      localComputerPreviews?.discardRunPreviews(activeRunId);
    }
    _clearArtifacts();
    _runMonitorToken = null;
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

abstract interface class VoiceDraftAmplitudeSource {
  Stream<double> voiceLevels();
}

class RecordVoiceDraftRecorder
    implements VoiceDraftRecorder, VoiceDraftAmplitudeSource {
  RecordVoiceDraftRecorder() : _recorder = AudioRecorder();

  final AudioRecorder _recorder;

  @override
  Future<bool> hasPermission() => _recorder.hasPermission();

  @override
  Future<void> start(String outputPath) => _recorder.start(
    const RecordConfig(
      encoder: AudioEncoder.wav,
      sampleRate: 16000,
      numChannels: 1,
    ),
    path: outputPath,
  );

  @override
  Stream<double> voiceLevels() => _recorder
      .onAmplitudeChanged(const Duration(milliseconds: 90))
      .map((amplitude) {
        final current = amplitude.current.isFinite ? amplitude.current : -60.0;
        return ((current + 60) / 60).clamp(0.0, 1.0).toDouble();
      });

  @override
  Future<String?> stop() async {
    final path = await _recorder.stop().timeout(
      const Duration(seconds: 2),
      onTimeout: () => throw StateError(
        'The microphone did not finish the recording in time.',
      ),
    );
    if (path == null) return null;
    try {
      return await _waitForFinalizedWav(path);
    } catch (_) {
      try {
        await File(path).delete();
      } on FileSystemException {
        // A failed temporary recording may already have been removed by macOS.
      }
      rethrow;
    }
  }

  Future<String> _waitForFinalizedWav(String path) async {
    final file = File(path);
    final deadline = DateTime.now().add(const Duration(seconds: 2));
    int? previousLength;
    var stableSamples = 0;
    while (DateTime.now().isBefore(deadline)) {
      try {
        final length = await file.length();
        final validHeader = length >= 44 && await _hasWavHeader(file);
        if (validHeader && length == previousLength) {
          stableSamples += 1;
          if (stableSamples >= 2) return path;
        } else {
          stableSamples = 0;
        }
        previousLength = length;
      } on FileSystemException {
        previousLength = null;
        stableSamples = 0;
      }
      await Future<void>.delayed(const Duration(milliseconds: 45));
    }
    throw StateError(
      'The voice recording did not finish writing a valid WAV file.',
    );
  }

  Future<bool> _hasWavHeader(File file) async {
    RandomAccessFile? handle;
    try {
      handle = await file.open(mode: FileMode.read);
      final header = await handle.read(12);
      return header.length == 12 &&
          header[0] == 0x52 &&
          header[1] == 0x49 &&
          header[2] == 0x46 &&
          header[3] == 0x46 &&
          header[8] == 0x57 &&
          header[9] == 0x41 &&
          header[10] == 0x56 &&
          header[11] == 0x45;
    } on FileSystemException {
      return false;
    } finally {
      final openedHandle = handle;
      if (openedHandle != null) await openedHandle.close();
    }
  }

  @override
  Future<void> cancel() => _recorder.cancel();

  @override
  Future<void> dispose() => _recorder.dispose();
}

class TalkView extends StatefulWidget {
  const TalkView({
    super.key,
    required this.controller,
    this.controllerResolver,
    this.voiceRecorder,
    this.ambientRealtimeFactory,
    this.quickEntry = false,
    this.ambientVoice = false,
    this.onQuickEntryReady,
    this.onExitQuickEntry,
    this.localComputer,
  });

  final TalkController controller;
  final TalkController Function()? controllerResolver;
  final VoiceDraftRecorder? voiceRecorder;
  final AmbientRealtimeVoiceController Function()? ambientRealtimeFactory;
  final bool quickEntry;
  final bool ambientVoice;
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
  AmbientRealtimeVoiceController? realtimeVoice;
  String strategy = 'auto';
  String commandMode = 'orchestrate';
  final commandReferences = <TalkCommandContextReference>[];
  TalkCommandModelCatalog? commandModelCatalog;
  String? commandModelChoiceId;
  String? commandReasoningLevel;
  bool commandModelLoading = false;
  Object? commandModelError;
  int commandModelLoadGeneration = 0;
  TalkExecutionTarget executionTarget = TalkExecutionTarget.agent;
  bool startingVoiceDraft = false;
  bool recording = false;
  bool finalizingVoiceDraft = false;
  double voiceLevel = 0;
  StreamSubscription<double>? voiceLevelSubscription;
  String? recordingError;
  String? voiceDraftNotice;
  int voiceDraftGeneration = 0;
  bool ambientSessionSent = false;
  String? ambientSubmittedText;
  String? ambientSpokenText;
  bool syncingRealtimeTranscript = false;
  DesktopAmbientVoiceState? lastPublishedAmbientState;

  @override
  void initState() {
    super.initState();
    recorder = widget.voiceRecorder ?? RecordVoiceDraftRecorder();
    if (widget.ambientVoice) {
      realtimeVoice = widget.ambientRealtimeFactory?.call()
        ?..addListener(_handleRealtimeVoiceChanged);
    }
    input.addListener(_handleComposerChanged);
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(loadCommandModelCatalog());
    });
    if (widget.quickEntry) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        widget.onQuickEntryReady?.call();
        if (widget.ambientVoice) unawaited(_startAmbientVoice());
      });
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        widget.controller.reconcileAcceptedRun();
        if (widget.controller.conversationHistorySupported) {
          unawaited(widget.controller.loadRecentThreads());
        }
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
        oldWidget.controller != widget.controller) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        unawaited(loadCommandModelCatalog());
        widget.controller.reconcileAcceptedRun();
        if (widget.controller.conversationHistorySupported) {
          unawaited(widget.controller.loadRecentThreads());
        }
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
    if (widget.ambientVoice) {
      unawaited(
        appDesktopHostBridge.updateAmbientVoiceState(
          DesktopAmbientVoiceState.asleep,
        ),
      );
    }
    input.removeListener(_handleComposerChanged);
    input.dispose();
    inputFocus.dispose();
    scroll.dispose();
    final realtime = realtimeVoice;
    realtimeVoice = null;
    realtime?.removeListener(_handleRealtimeVoiceChanged);
    realtime?.dispose();
    unawaited(_disposeRecorder());
    super.dispose();
  }

  void _handleComposerChanged() {
    final realtime = realtimeVoice;
    if (!syncingRealtimeTranscript &&
        !ambientSessionSent &&
        realtime?.phase == AmbientRealtimeVoicePhase.review &&
        realtime!.transcript != input.text) {
      realtime.editTranscript(input.text);
    }
    if (mounted && widget.ambientVoice) setState(() {});
  }

  void _handleRealtimeVoiceChanged() {
    final realtime = realtimeVoice;
    if (!mounted || realtime == null) return;
    final conversationId = realtime.conversationId;
    if (conversationId != null) {
      widget.controller.adoptConversationThreadId(conversationId);
    }
    if (!ambientSessionSent && input.text != realtime.transcript) {
      syncingRealtimeTranscript = true;
      input.text = realtime.transcript;
      input.selection = TextSelection.collapsed(offset: input.text.length);
      syncingRealtimeTranscript = false;
    }
    setState(() {});
  }

  Future<void> _disposeRecorder() async {
    try {
      await voiceLevelSubscription?.cancel();
      voiceLevelSubscription = null;
    } catch (_) {
      // Amplitude observation is optional and cannot block recorder cleanup.
    }
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

  TalkCommandModelChoice? get selectedCommandModel => commandModelCatalog
      ?.choices
      .where((choice) => choice.id == commandModelChoiceId)
      .firstOrNull;

  TalkCommandModelSelection? get commandModelSelection {
    final choice = selectedCommandModel;
    if (choice == null) return null;
    return TalkCommandModelSelection(
      choice: choice,
      reasoningLevel: commandReasoningLevel,
    );
  }

  String get commandModelScope => talkCommandModelScope(
    agentId: widget.controller.assignedAgent?.id,
    computerUse: executionTarget == TalkExecutionTarget.thisMac,
  );

  bool get voiceDraftBusy =>
      startingVoiceDraft ||
      recording ||
      finalizingVoiceDraft ||
      _realtimeVoiceBusy ||
      widget.controller.transcribing;

  bool get _realtimeVoiceBusy => _realtimeCaptureActive;

  bool get _thisMacReadyForCommand {
    final localComputer = widget.localComputer;
    return localComputer?.canClaimCommands == true &&
        localComputer?.phase == LocalComputerBrokerPhase.ready;
  }

  String get _thisMacUnavailableMessage {
    final localComputer = widget.localComputer;
    if (localComputer == null || !localComputer.canClaimCommands) {
      return 'Open the main Asael window to use this Mac.';
    }
    return switch (localComputer.phase) {
      LocalComputerBrokerPhase.permissionsRequired => 'Allow Accessibility and Screen Recording in Settings before Asael uses this Mac.',
      LocalComputerBrokerPhase.degraded =>
        'This Mac is reconnecting. Wait for the ready status, then try again.',
      LocalComputerBrokerPhase.starting =>
        'Asael is still checking this Mac. Try again when it is ready.',
      LocalComputerBrokerPhase.active =>
        'Asael is already using this Mac. Finish or stop that task first.',
      LocalComputerBrokerPhase.unavailable =>
        'This build cannot use the installed Mac.',
      LocalComputerBrokerPhase.disabled || LocalComputerBrokerPhase.stopped =>
        'Turn on This Mac in Settings before sending a computer task.',
      LocalComputerBrokerPhase.ready => 'This Mac is ready.',
    };
  }

  bool get _realtimeCaptureActive => switch (realtimeVoice?.phase) {
    AmbientRealtimeVoicePhase.requestingPermission ||
    AmbientRealtimeVoicePhase.connecting ||
    AmbientRealtimeVoicePhase.listening ||
    AmbientRealtimeVoicePhase.speechDetected ||
    AmbientRealtimeVoicePhase.reconnecting ||
    AmbientRealtimeVoicePhase.finishing => true,
    _ => false,
  };

  Future<void> _startAmbientVoice() async {
    if (appDesktopHostBridge.supported) {
      try {
        final availability = await appDesktopHostBridge
            .getAmbientVoiceAvailability();
        if (!availability.available) {
          if (mounted) {
            setState(() {
              recordingError = 'Ambient Command is turned off. Turn it on in Settings → General to use the microphone.';
            });
          }
          return;
        }
      } catch (error) {
        if (mounted) {
          setState(() {
            recordingError = 'Asael could not read the Ambient Command setting. Open Settings and try again.';
          });
        }
        return;
      }
    }
    if (recordingError != null || voiceDraftNotice != null) {
      setState(() {
        recordingError = null;
        voiceDraftNotice = null;
      });
    }
    widget.controller.clearVoiceError();
    final realtime = realtimeVoice;
    if (realtime == null) {
      await toggleVoiceDraft();
      return;
    }
    if (realtime.isSpeechPlaying) await realtime.interruptSpeech();
    ambientSessionSent = false;
    ambientSubmittedText = null;
    ambientSpokenText = null;
    try {
      await realtime.start(
        conversationId: widget.controller.threadId,
        mode: commandMode,
        providerConsent: true,
      );
    } catch (error) {
      if (!mounted) return;
      setState(() => recordingError = _ambientRealtimeError(error));
    }
  }

  Future<void> _toggleAmbientVoice() async {
    final realtime = realtimeVoice;
    if (realtime == null) {
      await toggleVoiceDraft();
      return;
    }
    if (realtime.isSpeechPlaying) {
      await realtime.interruptSpeech();
      await _startAmbientVoice();
      return;
    }
    if (realtime.isListening) {
      await realtime.stopAndReview();
      return;
    }
    await _startAmbientVoice();
  }

  String _ambientRealtimeError(Object error) => switch (error) {
    AmbientVoiceException(:final message) => message,
    ApiException(:final message) => _boundedDisplayText(message, 320),
    _ => 'Realtime voice could not start. Check the microphone and the model selected in Settings, then try again.',
  };

  Future<void> loadCommandModelCatalog() async {
    final expectedScope = commandModelScope;
    final generation = ++commandModelLoadGeneration;
    if (mounted) {
      setState(() {
        commandModelLoading = true;
        commandModelError = null;
      });
    }
    try {
      final catalog = await widget.controller.loadCommandModelCatalog(
        commandScope: expectedScope,
      );
      if (!mounted || generation != commandModelLoadGeneration) return;
      if (expectedScope != commandModelScope) {
        unawaited(loadCommandModelCatalog());
        return;
      }
      if (catalog.scope != expectedScope) {
        throw FormatException(
          'The model catalog did not match the selected work context.',
        );
      }
      setState(() {
        commandModelCatalog = catalog;
        final selected = catalog.choices
            .where((choice) => choice.id == commandModelChoiceId)
            .firstOrNull;
        if (selected == null) {
          commandModelChoiceId = null;
          commandReasoningLevel = null;
        } else if (commandReasoningLevel != null &&
            !selected.reasoningOptions.any(
              (option) => option.id == commandReasoningLevel,
            )) {
          commandReasoningLevel = null;
        }
      });
    } catch (error) {
      if (!mounted || generation != commandModelLoadGeneration) return;
      setState(() {
        commandModelCatalog = null;
        commandModelChoiceId = null;
        commandReasoningLevel = null;
        commandModelError = error;
      });
    } finally {
      if (mounted && generation == commandModelLoadGeneration) {
        setState(() => commandModelLoading = false);
      }
    }
  }

  Future<void> interruptVoiceDraft() async {
    voiceDraftGeneration += 1;
    final realtime = realtimeVoice;
    if (realtime != null) {
      if (realtime.isSpeechPlaying) await realtime.interruptSpeech();
      if (_realtimeCaptureActive) await realtime.cancel();
    }
    if (mounted && (startingVoiceDraft || recording || finalizingVoiceDraft)) {
      setState(() {
        startingVoiceDraft = false;
        recording = false;
        finalizingVoiceDraft = false;
        voiceLevel = 0;
      });
    }
    try {
      await voiceLevelSubscription?.cancel();
      voiceLevelSubscription = null;
    } catch (_) {
      // Amplitude observation is optional and has no recording authority.
    }
    try {
      await recorder.cancel();
    } catch (_) {
      // Lifecycle interruption is fail-closed even if the OS ended first.
    }
  }

  Future<void> _startVoiceLevelTracking() async {
    await voiceLevelSubscription?.cancel();
    voiceLevelSubscription = null;
    final VoiceDraftAmplitudeSource? amplitudeSource =
        recorder is VoiceDraftAmplitudeSource
        ? recorder as VoiceDraftAmplitudeSource
        : null;
    if (amplitudeSource == null) {
      if (mounted && recording) setState(() => voiceLevel = .18);
      return;
    }
    try {
      voiceLevelSubscription = amplitudeSource.voiceLevels().listen(
        (level) {
          if (!mounted || !recording) return;
          final smoothed = voiceLevel * .54 + level * .46;
          setState(() => voiceLevel = smoothed.clamp(0.0, 1.0).toDouble());
        },
        onError: (_) {
          if (mounted && recording) setState(() => voiceLevel = .18);
        },
      );
    } catch (_) {
      if (mounted && recording) setState(() => voiceLevel = .18);
    }
  }

  Future<void> _stopVoiceLevelTracking() async {
    try {
      await voiceLevelSubscription?.cancel();
    } finally {
      voiceLevelSubscription = null;
      if (mounted && voiceLevel != 0) setState(() => voiceLevel = 0);
    }
  }

  void submit() {
    if (voiceDraftBusy) return;
    final value = input.text.trim();
    if (value.isEmpty) return;
    if (executionTarget == TalkExecutionTarget.thisMac &&
        !_thisMacReadyForCommand) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(_thisMacUnavailableMessage)));
      return;
    }
    final controller = widget.controllerResolver?.call() ?? widget.controller;
    final exactModelSelection = commandModelSelection;
    input.clear();
    if (recordingError != null || voiceDraftNotice != null) {
      setState(() {
        recordingError = null;
        voiceDraftNotice = null;
      });
    }
    final work = controller.send(
      value,
      mode: commandMode,
      strategy: strategy,
      executionTarget: executionTarget,
      contextReferences: List.unmodifiable(commandReferences),
      modelSelection: exactModelSelection,
    );
    setState(() {
      commandReferences.removeWhere(
        (item) => item.kind != 'agent' && item.kind != 'project',
      );
    });
    if (widget.quickEntry && !widget.ambientVoice) {
      widget.onExitQuickEntry?.call();
    }
    unawaited(work);
  }

  void selectCommandReference(TalkCommandContextReference reference) {
    setState(() {
      if (reference.kind == 'agent' || reference.kind == 'project') {
        commandReferences.removeWhere((item) => item.kind == reference.kind);
      }
      commandReferences.removeWhere((item) => item.key == reference.key);
      commandReferences.add(reference);
    });
    if (reference.kind == 'agent') {
      widget.controller.assignAgent(id: reference.id, name: reference.label);
      resetCommandModelCatalog();
    }
  }

  void removeCommandReference(TalkCommandContextReference reference) {
    setState(() {
      commandReferences.removeWhere((item) => item.key == reference.key);
    });
    if (reference.kind == 'agent' &&
        widget.controller.assignedAgent?.id == reference.id) {
      widget.controller.clearAssignedAgent();
      resetCommandModelCatalog();
    }
  }

  void clearAssignedAgent() {
    if (widget.controller.assignedAgent == null) return;
    widget.controller.clearAssignedAgent();
    setState(() {
      commandReferences.removeWhere((item) => item.kind == 'agent');
    });
    resetCommandModelCatalog();
  }

  void selectExecutionTarget(TalkExecutionTarget value) {
    if (value == executionTarget) return;
    setState(() => executionTarget = value);
    resetCommandModelCatalog();
  }

  void resetCommandModelCatalog() {
    setState(() {
      commandModelCatalog = null;
      commandModelChoiceId = null;
      commandReasoningLevel = null;
      commandModelError = null;
    });
    unawaited(loadCommandModelCatalog());
  }

  void selectCommandApproach(String mode) {
    if (!const {'orchestrate', 'research', 'execute', 'learn'}.contains(mode)) {
      return;
    }
    setState(() => commandMode = mode);
  }

  void selectCommandModel(String? choiceId) {
    final catalog = commandModelCatalog;
    final choice = catalog?.choices
        .where((candidate) => candidate.id == choiceId)
        .firstOrNull;
    setState(() {
      commandModelChoiceId = choice?.id;
      commandReasoningLevel = null;
      if (choice != null) strategy = 'direct';
    });
  }

  void selectCommandReasoning(String? reasoningLevel) {
    final choice = selectedCommandModel;
    if (reasoningLevel != null &&
        choice?.reasoningOptions.any((option) => option.id == reasoningLevel) !=
            true) {
      return;
    }
    setState(() {
      commandReasoningLevel = reasoningLevel;
      if (reasoningLevel != null) strategy = 'direct';
    });
  }

  Future<void> toggleVoiceDraft() async {
    if (startingVoiceDraft ||
        finalizingVoiceDraft ||
        widget.controller.transcribing ||
        widget.controller.sending) {
      return;
    }
    setState(() {
      recordingError = null;
      voiceDraftNotice = null;
    });
    widget.controller.clearVoiceError();
    if (recording) {
      final generation = voiceDraftGeneration;
      setState(() {
        recording = false;
        finalizingVoiceDraft = true;
        voiceLevel = 0;
      });
      await _stopVoiceLevelTracking();
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
        if (!mounted || generation != voiceDraftGeneration) return;
        setState(() => finalizingVoiceDraft = false);
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
        setState(() {
          voiceDraftNotice =
              'Voice draft added. Review or edit it before sending.';
        });
        inputFocus.requestFocus();
      } catch (error) {
        if (mounted && generation == voiceDraftGeneration) {
          setState(() {
            finalizingVoiceDraft = false;
            recordingError = _voiceCaptureError(error, whileStarting: false);
          });
        }
      }
      return;
    }

    final generation = ++voiceDraftGeneration;
    setState(() {
      startingVoiceDraft = true;
      voiceLevel = 0;
    });
    try {
      if (!await recorder.hasPermission()) {
        throw StateError('Microphone permission was not granted.');
      }
      if (!mounted || generation != voiceDraftGeneration) return;
      final path =
          '${Directory.systemTemp.path}/asael-voice-${DateTime.now().microsecondsSinceEpoch}.wav';
      await recorder.start(path);
      if (!mounted || generation != voiceDraftGeneration) {
        await recorder.cancel();
        return;
      }
      setState(() {
        startingVoiceDraft = false;
        recording = true;
        voiceLevel = .12;
      });
      await _startVoiceLevelTracking();
    } catch (error) {
      if (mounted && generation == voiceDraftGeneration) {
        setState(() {
          startingVoiceDraft = false;
          recording = false;
          voiceLevel = 0;
          recordingError = _voiceCaptureError(error, whileStarting: true);
        });
      }
    }
  }

  String _voiceCaptureError(Object error, {required bool whileStarting}) {
    final message = error.toString().toLowerCase();
    if (message.contains('permission') || message.contains('denied')) {
      return 'Microphone access is off. Allow Asael in System Settings → Privacy & Security → Microphone, then try again.';
    }
    if (whileStarting) {
      return 'Asael could not start recording. Check that a microphone is connected, then try again.';
    }
    return 'That recording could not be used. Your typed draft is safe, so you can record again.';
  }

  void _dismissVoiceFeedback() {
    widget.controller.clearVoiceError();
    setState(() {
      recordingError = null;
      voiceDraftNotice = null;
    });
  }

  Future<void> _retryVoiceDraft() async {
    _dismissVoiceFeedback();
    await toggleVoiceDraft();
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

  Future<void> _openRailSheet(_TalkRailSection initialSection) async {
    await showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      builder: (_) => FractionallySizedBox(
        heightFactor: .86,
        child: ListenableBuilder(
          listenable: widget.controller,
          builder: (_, _) => _TalkActivityPane(
            controller: widget.controller,
            initialSection: initialSection,
          ),
        ),
      ),
    );
  }

  Future<void> _openArtifactsSheet() =>
      _openRailSheet(_TalkRailSection.artifacts);

  Future<void> _openPromptQueueSheet() =>
      _openRailSheet(_TalkRailSection.queue);

  Future<void> _copyAssistantResponse(String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Answer copied')));
  }

  bool get _emptyAmbientRealtimeReview {
    final realtime = realtimeVoice;
    return realtime?.phase == AmbientRealtimeVoicePhase.review &&
        realtime!.transcript.trim().isEmpty;
  }

  AmbientVoicePhase get _ambientVoicePhase {
    final realtime = realtimeVoice;
    if (_realtimeAppearsOffline) return AmbientVoicePhase.offline;
    if (recordingError != null ||
        widget.controller.voiceErrorMessage != null ||
        realtime?.phase == AmbientRealtimeVoicePhase.error) {
      return AmbientVoicePhase.error;
    }
    if (realtime?.isSpeechPlaying == true) return AmbientVoicePhase.speaking;
    if (realtime != null) {
      switch (realtime.phase) {
        case AmbientRealtimeVoicePhase.requestingPermission:
        case AmbientRealtimeVoicePhase.connecting:
          return AmbientVoicePhase.starting;
        case AmbientRealtimeVoicePhase.listening:
        case AmbientRealtimeVoicePhase.speechDetected:
        case AmbientRealtimeVoicePhase.reconnecting:
          return AmbientVoicePhase.listening;
        case AmbientRealtimeVoicePhase.finishing:
          return AmbientVoicePhase.transcribing;
        case AmbientRealtimeVoicePhase.review:
          return _emptyAmbientRealtimeReview
              ? AmbientVoicePhase.error
              : AmbientVoicePhase.review;
        case AmbientRealtimeVoicePhase.idle:
        case AmbientRealtimeVoicePhase.playingSpeech:
        case AmbientRealtimeVoicePhase.stopped:
        case AmbientRealtimeVoicePhase.error:
          break;
      }
    }
    if (startingVoiceDraft) return AmbientVoicePhase.starting;
    if (recording) return AmbientVoicePhase.listening;
    if (finalizingVoiceDraft || widget.controller.transcribing) {
      return AmbientVoicePhase.transcribing;
    }
    if (widget.controller.waitingForApproval) {
      return AmbientVoicePhase.approval;
    }
    final status = widget.controller.status?.toLowerCase() ?? '';
    if (widget.controller.sending) {
      if (status.contains('approval') ||
          status.contains('authorization') ||
          status.contains('your input')) {
        return AmbientVoicePhase.approval;
      }
      return AmbientVoicePhase.running;
    }
    if (ambientSessionSent) {
      final reply = widget.controller.messages.lastOrNull;
      if (reply?.failed == true) return AmbientVoicePhase.error;
      if (reply?.role == TalkRole.assistant && reply!.text.trim().isNotEmpty) {
        return AmbientVoicePhase.completed;
      }
    }
    if (input.text.trim().isNotEmpty || voiceDraftNotice != null) {
      return AmbientVoicePhase.review;
    }
    return AmbientVoicePhase.asleep;
  }

  String get _ambientVoiceDetail {
    final realtime = realtimeVoice;
    if (_emptyAmbientRealtimeReview) {
      return 'I didn’t catch that. Try again.';
    }
    if (realtime != null &&
        const {
          AmbientRealtimeVoicePhase.requestingPermission,
          AmbientRealtimeVoicePhase.connecting,
          AmbientRealtimeVoicePhase.listening,
          AmbientRealtimeVoicePhase.speechDetected,
          AmbientRealtimeVoicePhase.reconnecting,
          AmbientRealtimeVoicePhase.finishing,
          AmbientRealtimeVoicePhase.review,
          AmbientRealtimeVoicePhase.playingSpeech,
          AmbientRealtimeVoicePhase.error,
        }.contains(realtime.phase)) {
      return realtime.detail;
    }
    final status = widget.controller.status;
    return switch (_ambientVoicePhase) {
      AmbientVoicePhase.asleep => 'Say what you want Asael to do.',
      AmbientVoicePhase.starting => 'Opening the private voice connection.',
      AmbientVoicePhase.listening => 'Speak naturally.',
      AmbientVoicePhase.transcribing => 'Finishing your request.',
      AmbientVoicePhase.review =>
        executionTarget == TalkExecutionTarget.thisMac
            ? 'Send the recognized request to this Mac.'
            : 'Send the recognized request to Asael.',
      AmbientVoicePhase.running =>
        status == null
            ? 'The task is continuing in the background.'
            : _humanCommandStatus(status),
      AmbientVoicePhase.speaking => 'Speak at any time to interrupt.',
      AmbientVoicePhase.approval => 'Open the visible approval to review the exact action. Voice cannot approve it.',
      AmbientVoicePhase.completed =>
        executionTarget == TalkExecutionTarget.thisMac
            ? 'The requested Mac task has finished.'
            : 'Asael has finished this request.',
      AmbientVoicePhase.offline =>
        'Check your network and configured voice provider, then try again.',
      AmbientVoicePhase.error =>
        recordingError ??
            realtime?.errorMessage ??
            widget.controller.voiceErrorMessage ??
            'The request did not finish. Try speaking again.',
    };
  }

  bool get _realtimeAppearsOffline {
    final realtime = realtimeVoice;
    if (realtime?.phase != AmbientRealtimeVoicePhase.error) return false;
    final message =
        '${realtime?.errorCode ?? ''} ${realtime?.errorMessage ?? ''}'
            .toLowerCase();
    return message.contains('network') ||
        message.contains('connection') ||
        message.contains('offline') ||
        message.contains('timeout') ||
        message.contains('too long to connect');
  }

  String? get _ambientLastResult {
    if (!ambientSessionSent) return null;
    final reply = widget.controller.messages.lastOrNull;
    if (reply?.role != TalkRole.assistant || reply!.text.trim().isEmpty) {
      return ambientSubmittedText == null
          ? null
          : 'Working on “${_boundedRunText(ambientSubmittedText, 100)}”';
    }
    return _boundedRunText(reply.text, 180);
  }

  void _selectAmbientDestination(bool useThisMac) {
    if (useThisMac && !_thisMacReadyForCommand) {
      setState(() => recordingError = _thisMacUnavailableMessage);
      return;
    }
    if (recordingError == _thisMacUnavailableMessage) {
      setState(() => recordingError = null);
    }
    selectExecutionTarget(
      useThisMac ? TalkExecutionTarget.thisMac : TalkExecutionTarget.agent,
    );
  }

  Future<void> _closeAmbientVoice() async {
    await interruptVoiceDraft();
    await realtimeVoice?.cancel();
    lastPublishedAmbientState = DesktopAmbientVoiceState.asleep;
    unawaited(
      appDesktopHostBridge.updateAmbientVoiceState(
        DesktopAmbientVoiceState.asleep,
      ),
    );
    widget.onExitQuickEntry?.call();
  }

  Future<void> _stopAmbientWork() async {
    await interruptVoiceDraft();
    await realtimeVoice?.interruptSpeech();
    final localComputer = widget.localComputer;
    await Future.wait<void>([
      widget.controller.cancel(),
      if (localComputer?.active == true) localComputer!.stopNow(),
    ]);
  }

  Future<void> _openAmbientApproval() async {
    final route = widget.controller.pendingApprovalRoute ?? '/inbox';
    await interruptVoiceDraft();
    await realtimeVoice?.interruptSpeech();
    lastPublishedAmbientState = DesktopAmbientVoiceState.asleep;
    unawaited(
      appDesktopHostBridge.updateAmbientVoiceState(
        DesktopAmbientVoiceState.asleep,
      ),
    );
    await appDesktopHostBridge.showMainPresentation();
    if (mounted) context.go(route);
  }

  Future<void> _submitAmbientVoice() async {
    if (voiceDraftBusy || widget.controller.sending) return;
    final text = input.text.trim();
    if (text.isEmpty) return;
    if (executionTarget == TalkExecutionTarget.thisMac) {
      final localComputer = widget.localComputer;
      final ready =
          _thisMacReadyForCommand &&
          localComputer != null &&
          await localComputer.prepareForCommand();
      if (!mounted) return;
      if (!ready) {
        final message = _thisMacUnavailableMessage;
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(message)));
        setState(() => recordingError = message);
        return;
      }
    }
    final realtime = realtimeVoice;
    if (realtime != null) {
      try {
        if (realtime.transcript != text ||
            realtime.phase != AmbientRealtimeVoicePhase.review) {
          realtime.editTranscript(text);
        }
        realtime.attestReview(true);
        await realtime.finish(AmbientVoiceOutcome.sent);
      } catch (error) {
        if (!mounted) return;
        setState(() => recordingError = _ambientRealtimeError(error));
        return;
      }
    }
    if (!mounted) return;
    setState(() {
      ambientSessionSent = true;
      ambientSubmittedText = text;
      recordingError = null;
    });
    submit();
  }

  void _scheduleAmbientSpeech(AmbientVoicePhase phase) {
    final realtime = realtimeVoice;
    if (realtime == null || phase != AmbientVoicePhase.completed) return;
    final reply = widget.controller.messages.lastOrNull;
    if (reply?.role != TalkRole.assistant ||
        reply!.failed ||
        reply.streaming ||
        reply.text.trim().isEmpty ||
        ambientSpokenText == reply.text) {
      return;
    }
    ambientSpokenText = reply.text;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || realtimeVoice != realtime) return;
      unawaited(_speakAmbientResult(realtime, reply.text));
    });
  }

  Future<void> _speakAmbientResult(
    AmbientRealtimeVoiceController realtime,
    String text,
  ) async {
    try {
      await realtime.speak(
        text,
        threadId: widget.controller.threadId,
        runId: widget.controller.runId,
        agentId: widget.controller.assignedAgent?.id,
      );
    } catch (error) {
      if (!mounted || realtimeVoice != realtime) return;
      setState(() {
        recordingError =
            'The answer is ready on screen, but Asael could not play it aloud. ${_ambientRealtimeError(error)}';
      });
    }
  }

  Future<void> _openAmbientFromToolbar() async {
    try {
      final availability = await appDesktopHostBridge
          .getAmbientVoiceAvailability();
      if (!mounted) return;
      if (!availability.available) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Ambient Command is off. Turn it on in Settings → General.',
            ),
          ),
        );
        return;
      }
      unawaited(context.push('/ambient-voice'));
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Ambient Command could not open. Check Settings and try again.',
          ),
        ),
      );
    }
  }

  Widget _buildAmbientVoice(BuildContext context) {
    final phase = _ambientVoicePhase;
    _publishAmbientVoiceState(phase);
    _scheduleAmbientSpeech(phase);
    final canSend =
        !voiceDraftBusy &&
        !widget.controller.sending &&
        input.text.trim().isNotEmpty &&
        (executionTarget != TalkExecutionTarget.thisMac ||
            _thisMacReadyForCommand);
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape): () =>
            unawaited(_closeAmbientVoice()),
        const SingleActivator(LogicalKeyboardKey.enter, meta: true): () {
          if (canSend) unawaited(_submitAmbientVoice());
        },
      },
      child: AmbientVoiceSurface(
        phase: phase,
        level: realtimeVoice?.level ?? voiceLevel,
        transcript: input.text,
        useThisMac: executionTarget == TalkExecutionTarget.thisMac,
        thisMacAvailable: _thisMacReadyForCommand,
        thisMacUnavailableReason: _thisMacUnavailableMessage,
        detail: _ambientVoiceDetail,
        error: phase == AmbientVoicePhase.error
            ? _emptyAmbientRealtimeReview
                  ? _ambientVoiceDetail
                  : recordingError ??
                        realtimeVoice?.errorMessage ??
                        widget.controller.voiceErrorMessage
            : null,
        lastResult: _ambientLastResult,
        onDestinationChanged: _selectAmbientDestination,
        onMicrophonePressed:
            widget.controller.sending || widget.controller.transcribing
            ? null
            : () => unawaited(_toggleAmbientVoice()),
        onSend: canSend ? () => unawaited(_submitAmbientVoice()) : null,
        onStop:
            phase == AmbientVoicePhase.running ||
                phase == AmbientVoicePhase.approval
            ? () => unawaited(_stopAmbientWork())
            : null,
        onReviewApproval: phase == AmbientVoicePhase.approval
            ? () => unawaited(_openAmbientApproval())
            : null,
        onClose: () => unawaited(_closeAmbientVoice()),
      ),
    );
  }

  void _publishAmbientVoiceState(AmbientVoicePhase phase) {
    final state = switch (phase) {
      AmbientVoicePhase.starting ||
      AmbientVoicePhase.listening ||
      AmbientVoicePhase.transcribing => DesktopAmbientVoiceState.listening,
      AmbientVoicePhase.review => DesktopAmbientVoiceState.review,
      AmbientVoicePhase.running => DesktopAmbientVoiceState.running,
      AmbientVoicePhase.speaking => DesktopAmbientVoiceState.speaking,
      AmbientVoicePhase.approval => DesktopAmbientVoiceState.approval,
      AmbientVoicePhase.offline => DesktopAmbientVoiceState.offline,
      AmbientVoicePhase.error => DesktopAmbientVoiceState.error,
      AmbientVoicePhase.asleep ||
      AmbientVoicePhase.completed => DesktopAmbientVoiceState.asleep,
    };
    if (lastPublishedAmbientState == state) return;
    lastPublishedAmbientState = state;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !widget.ambientVoice) return;
      unawaited(appDesktopHostBridge.updateAmbientVoiceState(state));
    });
  }

  Widget _buildQuickEntry(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final macos = usesMacosPresentation();
    final mac = MacosThemeColors.of(context);
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
                    elevation: macos ? 0 : 10,
                    shadowColor: Colors.black.withValues(alpha: .16),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(macos ? 10 : 22),
                      side: macos
                          ? BorderSide(color: mac.divider)
                          : BorderSide.none,
                    ),
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
                            child: Wrap(
                              spacing: 8,
                              runSpacing: 8,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              children: [
                                if (widget.controller.assignedAgent
                                    case final assignedAgent?)
                                  InputChip(
                                    key: const ValueKey(
                                      'quick-entry-assigned-agent',
                                    ),
                                    avatar: const Icon(
                                      Icons.smart_toy_outlined,
                                      size: 17,
                                    ),
                                    label: Text(
                                      '${assignedAgent.name} · Direct',
                                    ),
                                    tooltip:
                                        'Commands run directly as ${assignedAgent.name}',
                                    onDeleted: widget.controller.sending
                                        ? null
                                        : clearAssignedAgent,
                                  ),
                                _ModelThinkingControls(
                                  catalog: commandModelCatalog,
                                  selectedChoiceId: commandModelChoiceId,
                                  reasoningLevel: commandReasoningLevel,
                                  loading: commandModelLoading,
                                  error: commandModelError,
                                  onModelChanged: selectCommandModel,
                                  onReasoningChanged: selectCommandReasoning,
                                  onRefresh: () =>
                                      unawaited(loadCommandModelCatalog()),
                                  compact: true,
                                ),
                                _ExecutionTargetMenu(
                                  value: executionTarget,
                                  compact: true,
                                  localComputer: widget.localComputer,
                                  onChanged: selectExecutionTarget,
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(height: 9),
                          TalkCommandComposer(
                            key: const ValueKey('quick-entry-input'),
                            controller: input,
                            focusNode: inputFocus,
                            selected: commandReferences,
                            catalogLoader:
                                widget.controller.loadCommandContextCatalog,
                            onSelected: selectCommandReference,
                            onRemoved: removeCommandReference,
                            onApproach: selectCommandApproach,
                            autofocus: true,
                            minLines: 1,
                            maxLines: 4,
                            onSubmitted: (_) => submit(),
                            hintText: 'What needs to move?',
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
    if (widget.ambientVoice) {
      return ListenableBuilder(
        listenable: widget.controller,
        builder: (_, _) => _buildAmbientVoice(context),
      );
    }
    if (widget.quickEntry) return _buildQuickEntry(context);
    final macos = usesMacosPresentation();
    final mac = MacosThemeColors.of(context);
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: macos ? 52 : null,
        titleSpacing: macos ? 18 : null,
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
              tooltip: 'Open Ambient Command',
              onPressed: () => unawaited(_openAmbientFromToolbar()),
              icon: const Icon(Icons.graphic_eq_rounded),
            ),
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
          ListenableBuilder(
            listenable: widget.controller,
            builder: (_, _) {
              if (MediaQuery.sizeOf(context).width >= 1180) {
                return const SizedBox.shrink();
              }
              return Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconButton(
                    tooltip: 'What Asael is doing',
                    onPressed: () => _openRailSheet(_TalkRailSection.activity),
                    icon: widget.controller.activities.isEmpty
                        ? const Icon(Icons.bolt_outlined)
                        : Badge.count(
                            count: widget.controller.activities.length,
                            child: const Icon(Icons.bolt_outlined),
                          ),
                  ),
                  if (widget.controller.artifacts.isNotEmpty)
                    IconButton(
                      tooltip: 'Run artifacts',
                      onPressed: _openArtifactsSheet,
                      icon: Badge.count(
                        count: widget.controller.artifacts.length,
                        child: const Icon(Icons.auto_awesome_mosaic_outlined),
                      ),
                    ),
                  IconButton(
                    tooltip: 'Prompt queue',
                    onPressed: _openPromptQueueSheet,
                    icon: widget.controller.promptQueue.isEmpty
                        ? const Icon(Icons.playlist_play_rounded)
                        : Badge.count(
                            count: widget.controller.promptQueue.length,
                            child: const Icon(Icons.playlist_play_rounded),
                          ),
                  ),
                ],
              );
            },
          ),
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Center(
              child: Tooltip(
                message: macos
                    ? 'Your work stays inside Asael\'s protected, approval-aware execution boundary.'
                    : 'Actions are governed by approvals and policy.',
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.surfaceContainerHigh,
                    borderRadius: BorderRadius.circular(macos ? 6 : 99),
                    border: macos ? Border.all(color: mac.divider) : null,
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        macos
                            ? Icons.lock_outline_rounded
                            : Icons.shield_outlined,
                        size: 15,
                      ),
                      const SizedBox(width: 5),
                      Text(macos ? 'Private & protected' : 'Governed'),
                    ],
                  ),
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
            final assignedAgent = widget.controller.assignedAgent;
            final voiceErrorMessage =
                recordingError ?? widget.controller.voiceErrorMessage;
            final conversation = Column(
              children: [
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 180),
                  transitionBuilder: (child, animation) => FadeTransition(
                    opacity: animation,
                    child: SizeTransition(
                      sizeFactor: animation,
                      alignment: Alignment.topCenter,
                      child: child,
                    ),
                  ),
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
                              const _CommandLiveGlyph(),
                              const SizedBox(width: 10),
                              Text(
                                _humanCommandStatus(widget.controller.status!),
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
                          padding: EdgeInsets.symmetric(
                            horizontal: macos ? 24 : 16,
                            vertical: 16,
                          ),
                          itemCount: widget.controller.messages.length,
                          itemBuilder: (_, i) {
                            final m = widget.controller.messages[i];
                            final artifact = widget.controller.selectedArtifact;
                            final artifactContent =
                                widget.controller.selectedArtifactContent;
                            final showArtifact =
                                m.role == TalkRole.assistant &&
                                i == widget.controller.messages.length - 1 &&
                                artifact != null &&
                                artifactContent != null &&
                                artifactContent.assetId == artifact.assetId &&
                                (artifact.kind == 'image' ||
                                    artifact.kind == 'computer' ||
                                    artifact.kind == 'terminal');
                            return Align(
                              alignment: m.role == TalkRole.user
                                  ? Alignment.centerRight
                                  : Alignment.centerLeft,
                              child: Container(
                                constraints: const BoxConstraints(
                                  maxWidth: 760,
                                ),
                                margin: EdgeInsets.only(
                                  bottom: macos ? 10 : 14,
                                ),
                                padding: EdgeInsets.symmetric(
                                  horizontal: macos ? 14 : 16,
                                  vertical: macos ? 11 : 14,
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
                                    topLeft: Radius.circular(macos ? 9 : 20),
                                    topRight: Radius.circular(macos ? 9 : 20),
                                    bottomLeft: Radius.circular(
                                      macos
                                          ? (m.role == TalkRole.user ? 9 : 4)
                                          : (m.role == TalkRole.user ? 20 : 6),
                                    ),
                                    bottomRight: Radius.circular(
                                      macos
                                          ? (m.role == TalkRole.user ? 4 : 9)
                                          : (m.role == TalkRole.user ? 6 : 20),
                                    ),
                                  ),
                                  border: m.failed
                                      ? Border.all(
                                          color: Theme.of(context)
                                              .colorScheme
                                              .error,
                                        )
                                      : macos
                                      ? Border.all(color: mac.divider)
                                      : null,
                                ),
                                child: m.streaming && m.text.isEmpty
                                    ? const AsaelMascot(
                                        state: AsaelMascotState.working,
                                        size: 38,
                                      )
                                    : Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          if (m.role == TalkRole.assistant)
                                            TalkRichMessage(
                                              text: m.text,
                                              failed: m.failed,
                                            )
                                          else
                                            SelectableText(m.text),
                                          if (showArtifact) ...[
                                            const SizedBox(height: 12),
                                            _TalkInlineArtifactPreview(
                                              artifact: artifact,
                                              content: artifactContent,
                                            ),
                                          ],
                                          if (m.role == TalkRole.assistant &&
                                              !m.streaming &&
                                              m.text.isNotEmpty) ...[
                                            const SizedBox(height: 9),
                                            Divider(
                                              height: 1,
                                              color: Theme.of(context)
                                                  .colorScheme
                                                  .outlineVariant,
                                            ),
                                            const SizedBox(height: 5),
                                            Wrap(
                                              spacing: 4,
                                              runSpacing: 4,
                                              children: [
                                                TextButton.icon(
                                                  onPressed: () =>
                                                      _copyAssistantResponse(
                                                        m.text,
                                                      ),
                                                  icon: const Icon(
                                                    Icons.copy_rounded,
                                                    size: 15,
                                                  ),
                                                  label: const Text(
                                                    'Copy answer',
                                                  ),
                                                ),
                                                if (i ==
                                                        widget
                                                                .controller
                                                                .messages
                                                                .length -
                                                            1 &&
                                                    widget
                                                        .controller
                                                        .activities
                                                        .isNotEmpty)
                                                  TextButton.icon(
                                                    onPressed: () =>
                                                        _openRailSheet(
                                                          _TalkRailSection
                                                              .activity,
                                                        ),
                                                    icon: const Icon(
                                                      Icons.bolt_outlined,
                                                      size: 15,
                                                    ),
                                                    label: const Text(
                                                      'View work',
                                                    ),
                                                  ),
                                              ],
                                            ),
                                          ],
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
                                              label: Text(
                                                widget
                                                            .controller
                                                            ._retryAssignedAgent ==
                                                        null
                                                    ? 'Retry'
                                                    : 'Retry as ${widget.controller._retryAssignedAgent!.name}',
                                              ),
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
                    margin: EdgeInsets.fromLTRB(
                      macos ? 16 : 10,
                      0,
                      macos ? 16 : 10,
                      macos ? 12 : 8,
                    ),
                    padding: EdgeInsets.fromLTRB(
                      macos ? 12 : 14,
                      macos ? 10 : 12,
                      macos ? 12 : 14,
                      macos ? 12 : 14,
                    ),
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.surface,
                      borderRadius: BorderRadius.circular(macos ? 10 : 24),
                      border: macos ? Border.all(color: mac.divider) : null,
                      boxShadow: macos
                          ? const []
                          : [
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
                                  if (assignedAgent != null)
                                    InputChip(
                                      key: const ValueKey(
                                        'talk-assigned-agent',
                                      ),
                                      avatar: const Icon(
                                        Icons.smart_toy_outlined,
                                        size: 17,
                                      ),
                                      label: Text(
                                        '${assignedAgent.name} · selected Agent',
                                      ),
                                      tooltip:
                                          'Commands run directly as ${assignedAgent.name}',
                                      onDeleted: widget.controller.sending
                                          ? null
                                          : clearAssignedAgent,
                                    ),
                                  SegmentedButton<String>(
                                    segments: [
                                      ButtonSegment(
                                        value: 'auto',
                                        label: Text(
                                          macos ? 'Use a team' : 'Orchestrate',
                                        ),
                                        tooltip: macos
                                            ? 'Let Asael bring in specialists when they help'
                                            : null,
                                        icon: const Icon(
                                          Icons.groups_2_outlined,
                                          size: 16,
                                        ),
                                      ),
                                      ButtonSegment(
                                        value: 'direct',
                                        label: Text(
                                          macos ? 'Work alone' : 'Direct',
                                        ),
                                        tooltip: macos
                                            ? 'Keep this request with one agent'
                                            : null,
                                        icon: const Icon(
                                          Icons.person_outline_rounded,
                                          size: 16,
                                        ),
                                      ),
                                    ],
                                    selected: {
                                      assignedAgent == null
                                          ? strategy
                                          : 'direct',
                                    },
                                    showSelectedIcon: false,
                                    style: const ButtonStyle(
                                      visualDensity: VisualDensity.compact,
                                    ),
                                    onSelectionChanged: assignedAgent != null
                                        ? null
                                        : (value) => setState(
                                            () => strategy = value.first,
                                          ),
                                  ),
                                  _ModelThinkingControls(
                                    catalog: commandModelCatalog,
                                    selectedChoiceId: commandModelChoiceId,
                                    reasoningLevel: commandReasoningLevel,
                                    loading: commandModelLoading,
                                    error: commandModelError,
                                    onModelChanged: selectCommandModel,
                                    onReasoningChanged: selectCommandReasoning,
                                    onRefresh: () =>
                                        unawaited(loadCommandModelCatalog()),
                                  ),
                                  _ExecutionTargetMenu(
                                    value: executionTarget,
                                    localComputer: widget.localComputer,
                                    onChanged: selectExecutionTarget,
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 8),
                            if (macos &&
                                (startingVoiceDraft ||
                                    recording ||
                                    finalizingVoiceDraft ||
                                    widget.controller.transcribing ||
                                    voiceErrorMessage != null ||
                                    voiceDraftNotice != null))
                              Padding(
                                padding: const EdgeInsets.only(bottom: 8),
                                child: _VoiceDraftFeedback(
                                  starting: startingVoiceDraft,
                                  recording: recording,
                                  finalizing: finalizingVoiceDraft,
                                  transcribing: widget.controller.transcribing,
                                  level: voiceLevel,
                                  error: voiceErrorMessage,
                                  notice: voiceDraftNotice,
                                  onDismiss: voiceDraftBusy
                                      ? null
                                      : _dismissVoiceFeedback,
                                  onRecordAgain:
                                      voiceErrorMessage == null ||
                                          widget.controller.sending ||
                                          widget.controller.transcribing
                                      ? null
                                      : _retryVoiceDraft,
                                ),
                              ),
                            if (!macos &&
                                (startingVoiceDraft ||
                                    recording ||
                                    finalizingVoiceDraft ||
                                    widget.controller.transcribing))
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
                                      startingVoiceDraft
                                          ? 'Opening the microphone…'
                                          : recording
                                          ? 'Recording · tap stop to review transcript'
                                          : finalizingVoiceDraft
                                          ? 'Finishing the recording…'
                                          : 'Turning voice into an editable draft…',
                                    ),
                                  ],
                                ),
                              ),
                            if (!macos && voiceErrorMessage != null)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 8),
                                child: Align(
                                  alignment: Alignment.centerLeft,
                                  child: Text(
                                    voiceErrorMessage,
                                    style: TextStyle(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .error,
                                    ),
                                  ),
                                ),
                              ),
                            TalkCommandComposer(
                              controller: input,
                              focusNode: inputFocus,
                              selected: commandReferences,
                              catalogLoader:
                                  widget.controller.loadCommandContextCatalog,
                              onSelected: selectCommandReference,
                              onRemoved: removeCommandReference,
                              onApproach: selectCommandApproach,
                              autofocus:
                                  !kIsWeb &&
                                  defaultTargetPlatform == TargetPlatform.macOS,
                              minLines: 1,
                              maxLines: 5,
                              onSubmitted: voiceDraftBusy
                                  ? null
                                  : (_) => submit(),
                              hintText: 'Describe an outcome or ask a question',
                              suffixIcon: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  IconButton(
                                    tooltip: startingVoiceDraft
                                        ? 'Opening microphone'
                                        : finalizingVoiceDraft
                                        ? 'Finishing voice draft'
                                        : recording
                                        ? 'Stop and transcribe voice draft'
                                        : 'Record voice draft',
                                    onPressed:
                                        widget.controller.sending ||
                                            widget.controller.transcribing ||
                                            startingVoiceDraft ||
                                            finalizingVoiceDraft
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
                                    onPressed: voiceDraftBusy ? null : submit,
                                    icon: Icon(
                                      widget.controller.sending
                                          ? Icons.playlist_add_rounded
                                          : Icons.arrow_upward_rounded,
                                    ),
                                  ),
                                ],
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
                    width: macos ? 252 : 272,
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
                    width: macos ? 318 : 328,
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
                  width: macos ? 328 : 348,
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

class _TalkInlineArtifactPreview extends StatelessWidget {
  const _TalkInlineArtifactPreview({
    required this.artifact,
    required this.content,
  });

  final TalkMediaArtifactSummary artifact;
  final TalkArtifactContent content;

  @override
  Widget build(BuildContext context) {
    final terminal = content.terminal;
    if (terminal != null) {
      return _TerminalOutputPreview(
        preview: terminal,
        filename: artifact.filename,
        bytes: content.bytes,
        compact: true,
      );
    }
    final scheme = Theme.of(context).colorScheme;
    final temporary = artifact.status == 'temporary';
    final title = artifact.kind == 'computer'
        ? 'Screenshot from This Mac'
        : artifact.filename;
    return Semantics(
      label: title,
      image: true,
      child: Container(
        decoration: BoxDecoration(
          color: scheme.surfaceContainerLowest,
          borderRadius: BorderRadius.circular(14),
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
                child: Image.memory(
                  content.bytes,
                  fit: BoxFit.contain,
                  gaplessPlayback: true,
                  errorBuilder: (_, _, _) => Center(
                    child: Text(
                      'Screenshot preview unavailable',
                      style: TextStyle(color: scheme.onSurfaceVariant),
                    ),
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 9, 12, 10),
              child: Row(
                children: [
                  Icon(
                    artifact.kind == 'computer'
                        ? Icons.screenshot_monitor_outlined
                        : Icons.image_outlined,
                    size: 18,
                    color: scheme.primary,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        Text(
                          temporary
                              ? 'Private temporary preview · not kept in Conversation'
                              : '${artifact.mediaType} · ${TalkController._humanBytes(artifact.byteCount)}',
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
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _TerminalOutputPreview extends StatelessWidget {
  const _TerminalOutputPreview({
    required this.preview,
    required this.filename,
    required this.bytes,
    this.compact = false,
    this.embedded = false,
  });

  final LocalComputerTerminalPreview preview;
  final String filename;
  final Uint8List bytes;
  final bool compact;
  final bool embedded;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final output = preview.output;
    final folder = preview.relativeDirectory == '.'
        ? preview.workspaceName
        : '${preview.workspaceName}/${preview.relativeDirectory}';
    final succeeded = output.exitCode == 0;
    return Semantics(
      label:
          'Temporary terminal output for ${preview.executable}, exit ${output.exitCode}',
      child: Container(
        decoration: BoxDecoration(
          color: scheme.surfaceContainerLowest,
          borderRadius: embedded ? null : BorderRadius.circular(12),
          border: embedded ? null : Border.all(color: scheme.outlineVariant),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 9, 6, 8),
              child: Row(
                children: [
                  Icon(Icons.terminal_rounded, size: 18, color: scheme.primary),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          preview.commandLabel,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontFamily: 'Menlo',
                            fontSize: 11.5,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        Text(
                          '$folder · ${TalkController._terminalDuration(output.durationMs)} · temporary',
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
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 7,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: (succeeded ? scheme.primary : scheme.error)
                          .withValues(alpha: .12),
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      'Exit ${output.exitCode}',
                      style: TextStyle(
                        color: succeeded ? scheme.primary : scheme.error,
                        fontSize: 10.5,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Copy terminal output',
                    visualDensity: VisualDensity.compact,
                    onPressed: () => _copy(context),
                    icon: const Icon(Icons.copy_all_outlined, size: 17),
                  ),
                  IconButton(
                    tooltip: 'Save terminal output as…',
                    visualDensity: VisualDensity.compact,
                    onPressed: _save,
                    icon: const Icon(Icons.download_rounded, size: 18),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: scheme.outlineVariant),
            ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: compact ? 210 : 270,
                minHeight: compact ? 120 : 160,
              ),
              child: ColoredBox(
                color: scheme.surfaceContainerHighest,
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(12),
                  child: SelectableText.rich(
                    TextSpan(
                      style: TextStyle(
                        color: scheme.onSurface,
                        fontFamily: 'Menlo',
                        fontSize: 11,
                        height: 1.45,
                      ),
                      children: [
                        TextSpan(
                          text: 'STDOUT\n',
                          style: TextStyle(
                            color: scheme.primary,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        TextSpan(
                          text: output.stdout.isEmpty
                              ? '(no output)\n'
                              : '${output.stdout}\n',
                        ),
                        if (output.stdoutTruncated)
                          TextSpan(
                            text: '[Output shortened in this preview.]\n',
                            style: TextStyle(color: scheme.onSurfaceVariant),
                          ),
                        TextSpan(
                          text: '\nSTDERR\n',
                          style: TextStyle(
                            color: output.stderr.isEmpty
                                ? scheme.onSurfaceVariant
                                : scheme.error,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        TextSpan(
                          text: output.stderr.isEmpty
                              ? '(no errors)'
                              : output.stderr,
                        ),
                        if (output.stderrTruncated)
                          TextSpan(
                            text: '\n[Error output shortened in this preview.]',
                            style: TextStyle(color: scheme.onSurfaceVariant),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _copy(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: utf8.decode(bytes)));
    if (!context.mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Terminal output copied')));
  }

  Future<void> _save() async {
    await FilePicker.saveFile(
      dialogTitle: 'Save terminal output',
      fileName: filename,
      bytes: bytes,
    );
  }
}

class _ModelThinkingControls extends StatelessWidget {
  const _ModelThinkingControls({
    required this.catalog,
    required this.selectedChoiceId,
    required this.reasoningLevel,
    required this.loading,
    required this.error,
    required this.onModelChanged,
    required this.onReasoningChanged,
    required this.onRefresh,
    this.compact = false,
  });

  static const automaticValue = '__automatic__';
  static const refreshValue = '__refresh__';

  final TalkCommandModelCatalog? catalog;
  final String? selectedChoiceId;
  final String? reasoningLevel;
  final bool loading;
  final Object? error;
  final ValueChanged<String?> onModelChanged;
  final ValueChanged<String?> onReasoningChanged;
  final VoidCallback onRefresh;
  final bool compact;

  TalkCommandModelChoice? get selectedChoice => catalog?.choices
      .where((choice) => choice.id == selectedChoiceId)
      .firstOrNull;

  @override
  Widget build(BuildContext context) {
    final choice = selectedChoice;
    final reasoning = choice?.reasoningOptions
        .where((option) => option.id == reasoningLevel)
        .firstOrNull;
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        _modelMenu(context, choice),
        _reasoningMenu(context, choice, reasoning),
      ],
    );
  }

  Widget _modelMenu(BuildContext context, TalkCommandModelChoice? choice) {
    final choices = catalog?.choices ?? const <TalkCommandModelChoice>[];
    final message = error != null
        ? 'Model choices could not be refreshed. Automatic still uses your saved Settings route.'
        : catalog?.message ??
              'Automatic uses the model route saved in Settings.';
    return Semantics(
      label: 'Model: ${choice?.displayName ?? 'Automatic'}. $message',
      button: true,
      child: Tooltip(
        message: message,
        child: PopupMenuButton<String>(
          key: const ValueKey('talk-model-selector'),
          initialValue: choice?.id ?? automaticValue,
          tooltip: 'Choose a Settings-approved model',
          onSelected: (value) {
            if (value == refreshValue) {
              onRefresh();
            } else {
              onModelChanged(value == automaticValue ? null : value);
            }
          },
          itemBuilder: (context) => [
            const PopupMenuItem(
              value: automaticValue,
              child: ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: Icon(Icons.auto_awesome_rounded, size: 19),
                title: Text('Automatic'),
                subtitle: Text('Use the model route saved in Settings'),
              ),
            ),
            for (final option in choices)
              PopupMenuItem(
                value: option.id,
                child: ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(
                    option.route == 'primary'
                        ? Icons.star_outline_rounded
                        : Icons.alt_route_rounded,
                    size: 19,
                  ),
                  title: Text(option.displayName),
                  subtitle: Text(
                    '${option.providerLabel} · ${option.settingsRouteLabel}\n${option.displayModelId}',
                  ),
                  isThreeLine: true,
                ),
              ),
            if (error != null)
              const PopupMenuItem(
                value: refreshValue,
                child: ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(Icons.refresh_rounded, size: 19),
                  title: Text('Refresh model choices'),
                  subtitle: Text(
                    'Read the validated route from Settings again',
                  ),
                ),
              ),
          ],
          child: _selectorSurface(
            context,
            icon: loading
                ? Icons.sync_rounded
                : error != null
                ? Icons.warning_amber_rounded
                : Icons.memory_rounded,
            label: 'Model',
            value: choice?.displayName ?? 'Automatic',
          ),
        ),
      ),
    );
  }

  Widget _reasoningMenu(
    BuildContext context,
    TalkCommandModelChoice? choice,
    TalkCommandReasoningOption? reasoning,
  ) {
    final options =
        choice?.reasoningOptions ?? const <TalkCommandReasoningOption>[];
    final enabled = choice != null && options.isNotEmpty;
    final help = choice == null
        ? 'Choose a specific model to set Thinking. Automatic lets the saved Settings route decide.'
        : options.isEmpty
        ? '${choice.displayName} does not advertise adjustable Thinking levels.'
        : 'Automatic lets ${choice.displayName} use its provider and runtime default.';
    final menu = PopupMenuButton<String>(
      key: const ValueKey('talk-thinking-selector'),
      initialValue: reasoning?.id ?? automaticValue,
      enabled: enabled,
      tooltip: 'Choose how deeply this model thinks',
      onSelected: (value) =>
          onReasoningChanged(value == automaticValue ? null : value),
      itemBuilder: (context) => [
        const PopupMenuItem(
          value: automaticValue,
          child: ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.auto_mode_rounded, size: 19),
            title: Text('Automatic'),
            subtitle: Text('Use the provider and runtime default'),
          ),
        ),
        for (final option in options)
          PopupMenuItem(
            value: option.id,
            child: ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.psychology_alt_outlined, size: 19),
              title: Text(option.label),
              subtitle: Text(_reasoningDescription(option.id)),
            ),
          ),
      ],
      child: _selectorSurface(
        context,
        icon: Icons.psychology_alt_outlined,
        label: 'Thinking',
        value: reasoning?.label ?? 'Automatic',
        enabled: enabled,
      ),
    );
    return Semantics(
      label: 'Thinking: ${reasoning?.label ?? 'Automatic'}. $help',
      button: enabled,
      enabled: enabled,
      child: Tooltip(message: help, child: menu),
    );
  }

  Widget _selectorSurface(
    BuildContext context, {
    required IconData icon,
    required String label,
    required String value,
    bool enabled = true,
  }) {
    final scheme = Theme.of(context).colorScheme;
    final foreground = enabled
        ? scheme.onSurface
        : scheme.onSurfaceVariant.withValues(alpha: .62);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
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
            Icon(icon, size: 16, color: foreground),
            const SizedBox(width: 7),
            Text(
              '$label · $value',
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: foreground, fontWeight: FontWeight.w600),
            ),
            const SizedBox(width: 4),
            Icon(Icons.expand_more_rounded, size: 16, color: foreground),
          ],
        ),
      ),
    );
  }

  String _reasoningDescription(String id) => switch (id) {
    'low' => 'Faster for straightforward work',
    'medium' => 'A balanced amount of reasoning',
    'high' => 'More careful reasoning for harder work',
    'extra_high' => 'Deeper reasoning for complex work',
    'ultra' => 'Use the maximum available reasoning',
    _ => 'Supported by this model',
  };
}

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
    final auxiliaryWindow =
        coordinator != null && !coordinator.canClaimCommands;
    final status = _statusText(coordinator, auxiliaryWindow);
    final nativeStatus = coordinator?.status;
    final workspaces = nativeStatus?.commandWorkspaces ?? const [];
    final canManageFolders =
        coordinator != null &&
        !auxiliaryWindow &&
        !coordinator.changing &&
        nativeStatus?.commandHelperInstalled == true;
    return Semantics(
      label: 'Execution target: ${value.label}. $status',
      button: true,
      child: Tooltip(
        message: value == TalkExecutionTarget.thisMac ? status : value.detail,
        child: PopupMenuButton<String>(
          key: const ValueKey('talk-execution-target'),
          initialValue: 'target:${value.name}',
          constraints: const BoxConstraints(minWidth: 340, maxWidth: 420),
          tooltip: 'Choose how Asael can work',
          onSelected: (selection) {
            if (selection == 'target:agent') {
              onChanged(TalkExecutionTarget.agent);
              return;
            }
            if (selection == 'target:thisMac') {
              onChanged(TalkExecutionTarget.thisMac);
              return;
            }
            if (selection == 'workspace:add') {
              if (coordinator != null) {
                unawaited(coordinator.addCommandWorkspace());
              }
              return;
            }
            const removePrefix = 'workspace:remove:';
            if (selection.startsWith(removePrefix) && coordinator != null) {
              unawaited(
                coordinator.removeCommandWorkspace(
                  selection.substring(removePrefix.length),
                ),
              );
            }
          },
          itemBuilder: (context) => [
            for (final target in TalkExecutionTarget.values)
              PopupMenuItem<String>(
                value: 'target:${target.name}',
                enabled:
                    target != TalkExecutionTarget.thisMac || !auxiliaryWindow,
                child: ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(target.icon, size: 19),
                  title: Text(target.label),
                  subtitle: Text(
                    target == TalkExecutionTarget.thisMac
                        ? status
                        : target.detail,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
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
            const PopupMenuDivider(),
            PopupMenuItem<String>(
              enabled: false,
              height: 64,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Text(
                    'Command folders',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    _commandFolderStatus(nativeStatus, auxiliaryWindow),
                    style: TextStyle(
                      color: scheme.onSurfaceVariant,
                      fontSize: 11.5,
                    ),
                  ),
                ],
              ),
            ),
            for (final workspace in workspaces)
              PopupMenuItem<String>(
                value: 'workspace:remove:${workspace.id}',
                enabled: canManageFolders,
                child: ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.folder_outlined, size: 19),
                  title: Text(
                    workspace.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(
                    '${workspace.path}\nChoose to remove command access',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  trailing: const Icon(Icons.remove_circle_outline, size: 18),
                ),
              ),
            PopupMenuItem<String>(
              value: 'workspace:add',
              enabled: canManageFolders,
              child: const ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: Icon(Icons.create_new_folder_outlined, size: 19),
                title: Text('Allow another folder'),
                subtitle: Text(
                  'Choose a starting folder for approved commands',
                ),
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

  String _statusText(
    LocalComputerCoordinator? coordinator,
    bool auxiliaryWindow,
  ) {
    if (auxiliaryWindow) {
      return 'Open Conversation in the main Asael window to use this Mac.';
    }
    if (coordinator == null) {
      return 'This Mac status is unavailable in this client.';
    }
    final status = coordinator.status;
    if (status == null) {
      return coordinator.phase == LocalComputerBrokerPhase.starting
          ? 'Checking this Mac…'
          : 'This Mac is unavailable.';
    }
    if (coordinator.active) return 'Asael is working on this Mac now.';
    if (coordinator.phase == LocalComputerBrokerPhase.degraded) {
      return 'This Mac is reconnecting.';
    }
    if (!status.enabled ||
        coordinator.phase == LocalComputerBrokerPhase.stopped) {
      return 'Turn on This Mac in Settings to use local apps or commands.';
    }
    final appControl = status.computerUseReady;
    final commands = status.commandRunnerReady;
    if (appControl && commands) {
      return 'Can use apps and start approved commands from ${status.commandWorkspaces.length} ${status.commandWorkspaces.length == 1 ? 'folder' : 'folders'}.';
    }
    if (commands) {
      return 'Can start approved commands from ${status.commandWorkspaces.length} ${status.commandWorkspaces.length == 1 ? 'folder' : 'folders'}.';
    }
    if (appControl && status.commandHelperInstalled) {
      return 'Can use apps. Add a command folder to allow terminal work.';
    }
    if (appControl) return 'Can use apps on this Mac.';
    if (coordinator.phase == LocalComputerBrokerPhase.permissionsRequired) {
      return 'Allow Accessibility and Screen Recording in System Settings.';
    }
    return 'This Mac is not ready yet.';
  }

  String _commandFolderStatus(
    LocalComputerStatus? status,
    bool auxiliaryWindow,
  ) {
    if (auxiliaryWindow) {
      return 'Manage folder access from the main Asael window.';
    }
    if (status == null) return 'Checking the local command runner…';
    if (!status.commandHelperInstalled) {
      return 'The local command runner is not installed in this build.';
    }
    final count = status.commandWorkspaces.length;
    if (count == 0) {
      return 'Add a starting folder. Every exact command still needs approval.';
    }
    return '$count approved starting ${count == 1 ? 'folder' : 'folders'}. Every exact command still needs approval.';
  }
}

class _VoiceDraftFeedback extends StatelessWidget {
  const _VoiceDraftFeedback({
    required this.starting,
    required this.recording,
    required this.finalizing,
    required this.transcribing,
    required this.level,
    required this.error,
    required this.notice,
    required this.onDismiss,
    required this.onRecordAgain,
  });

  final bool starting, recording, finalizing, transcribing;
  final double level;
  final String? error, notice;
  final VoidCallback? onDismiss, onRecordAgain;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final state = error != null
        ? 'error'
        : starting
        ? 'starting'
        : recording
        ? 'recording'
        : finalizing
        ? 'finalizing'
        : transcribing
        ? 'transcribing'
        : 'ready';
    final (title, detail, color, mascotState) = switch (state) {
      'error' => (
        'Voice draft needs attention',
        error!,
        scheme.error,
        AsaelMascotState.attention,
      ),
      'starting' => (
        'Opening the microphone…',
        'Asael will only turn this recording into an editable draft.',
        scheme.primary,
        AsaelMascotState.ready,
      ),
      'recording' => (
        'Listening…',
        'Speak naturally. Stop when you are ready to turn it into text.',
        scheme.error,
        AsaelMascotState.listening,
      ),
      'finalizing' => (
        'Finishing the recording…',
        'Securing this voice draft before transcription starts.',
        scheme.secondary,
        AsaelMascotState.transcribing,
      ),
      'transcribing' => (
        'Writing your words…',
        'Your recording will appear below as an editable draft.',
        scheme.primary,
        AsaelMascotState.transcribing,
      ),
      _ => (
        'Voice draft added',
        notice ?? 'Review or edit it before sending.',
        scheme.tertiary,
        AsaelMascotState.success,
      ),
    };
    return Semantics(
      liveRegion: true,
      label: '$title. $detail',
      child: AnimatedSwitcher(
        duration: MediaQuery.disableAnimationsOf(context)
            ? Duration.zero
            : const Duration(milliseconds: 180),
        child: Container(
          key: ValueKey(state),
          width: double.infinity,
          padding: const EdgeInsets.fromLTRB(10, 8, 6, 8),
          decoration: BoxDecoration(
            color: color.withValues(alpha: .08),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: color.withValues(alpha: .24)),
          ),
          child: Row(
            children: [
              AsaelMascot(state: mascotState, size: 38),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: Theme.of(context).textTheme.labelMedium
                          ?.copyWith(color: color),
                    ),
                    const SizedBox(height: 1),
                    Text(
                      detail,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              if (recording)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: _VoiceSignal(color: color, level: level),
                )
              else if (transcribing)
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 10),
                  child: SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                )
              else if (onRecordAgain != null)
                TextButton.icon(
                  onPressed: onRecordAgain,
                  icon: const Icon(Icons.mic_none_rounded, size: 16),
                  label: const Text('Record again'),
                ),
              if (onDismiss != null)
                IconButton(
                  tooltip: 'Dismiss voice status',
                  visualDensity: VisualDensity.compact,
                  onPressed: onDismiss,
                  icon: const Icon(Icons.close_rounded, size: 17),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _VoiceSignal extends StatefulWidget {
  const _VoiceSignal({required this.color, required this.level});

  final Color color;
  final double level;

  @override
  State<_VoiceSignal> createState() => _VoiceSignalState();
}

class _VoiceSignalState extends State<_VoiceSignal>
    with SingleTickerProviderStateMixin {
  late final AnimationController controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      controller
        ..stop()
        ..value = .3;
    } else if (!controller.isAnimating) {
      controller.repeat();
    }
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final level = widget.level.clamp(.08, 1.0).toDouble();
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) => SizedBox(
        width: 30,
        height: 20,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            for (var index = 0; index < 5; index++)
              Container(
                width: 3,
                height:
                    4 +
                    13 *
                        level *
                        (.35 +
                            .65 *
                                (.5 +
                                    .5 *
                                        math.sin(
                                          controller.value * math.pi * 2 +
                                              index * .9,
                                        ))),
                decoration: BoxDecoration(
                  color: widget.color.withValues(alpha: .72),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _TalkActivityPane extends StatefulWidget {
  const _TalkActivityPane({
    required this.controller,
    this.initialSection = _TalkRailSection.activity,
  });

  final TalkController controller;
  final _TalkRailSection initialSection;

  @override
  State<_TalkActivityPane> createState() => _TalkActivityPaneState();
}

class _TalkActivityPaneState extends State<_TalkActivityPane> {
  late _TalkRailSection section;
  bool showTechnicalDetails = false;

  @override
  void initState() {
    super.initState();
    section = widget.initialSection;
  }

  TalkController get controller => widget.controller;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final activeCount = controller.activities
        .where((item) => item.state == TalkActivityState.active)
        .length;
    final (icon, title, detail) = switch (section) {
      _TalkRailSection.activity => (
        Icons.auto_awesome_outlined,
        'What Asael is doing',
        'Plans, tools, approvals and evidence',
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
                    tooltip: 'What Asael is doing',
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
            if (controller.runId != null &&
                (!usesMacosPresentation() || showTechnicalDetails))
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
                        'Protected run ${_shortId(controller.runId!)}',
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
    final macos = usesMacosPresentation();
    if (controller.activities.isEmpty) {
      return _RailEmpty(
        icon: Icons.auto_awesome_outlined,
        title: 'Ready when you are',
        detail: 'When work begins, you will see who is helping, what changed, and anything that needs you.',
        color: scheme.onSurfaceVariant,
      );
    }
    final technicalCount = controller.activities
        .where(_isTechnicalTalkActivity)
        .length;
    final visibleActivities = !macos || showTechnicalDetails
        ? controller.activities
        : controller.activities
              .where((activity) => !_isTechnicalTalkActivity(activity))
              .toList(growable: false);
    return Column(
      children: [
        if (macos)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  Icons.visibility_outlined,
                  size: 15,
                  color: scheme.onSurfaceVariant,
                ),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    'This is the observable work log. Private model reasoning is never exposed or stored.',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                      height: 1.35,
                    ),
                  ),
                ),
              ],
            ),
          ),
        if (macos && technicalCount > 0)
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 10, 2),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    showTechnicalDetails
                        ? 'Showing the full execution record'
                        : 'Technical execution details are hidden',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
                TextButton.icon(
                  onPressed: () => setState(
                    () => showTechnicalDetails = !showTechnicalDetails,
                  ),
                  icon: Icon(
                    showTechnicalDetails
                        ? Icons.visibility_off_outlined
                        : Icons.tune_rounded,
                    size: 15,
                  ),
                  label: Text(
                    showTechnicalDetails
                        ? 'Show less'
                        : 'Details ($technicalCount)',
                  ),
                ),
              ],
            ),
          ),
        Expanded(
          child: visibleActivities.isEmpty
              ? _RailEmpty(
                  icon: Icons.hourglass_top_rounded,
                  title: 'Asael is preparing',
                  detail: 'The useful milestones will appear here as the request moves forward.',
                  color: scheme.onSurfaceVariant,
                )
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                  itemCount: visibleActivities.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 9),
                  itemBuilder: (context, index) {
                    final activity = visibleActivities[index];
                    return _TalkActivityCard(
                      activity: activity,
                      technical: _isTechnicalTalkActivity(activity),
                    );
                  },
                ),
        ),
      ],
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
                if (content?.terminal case final terminal?)
                  _TerminalOutputPreview(
                    preview: terminal,
                    filename: selected.filename,
                    bytes: content!.bytes,
                    embedded: true,
                  )
                else ...[
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
                              controller.artifactError
                                      is LegacyComputerPreviewRetired
                                  ? 'Legacy browser preview retired'
                                  : controller.artifactError == null
                                  ? selected.isPresentation
                                        ? 'Private presentation ready to save'
                                        : 'Ready to save'
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
                                selected.title ?? selected.filename,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 12.5,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                              Text(
                                selected.isPresentation
                                    ? '${selected.filename} · ${selected.slideCount == null ? 'PowerPoint' : '${selected.slideCount} slides'} · Private · ${TalkController._humanBytes(selected.byteCount)}'
                                    : '${selected.mediaType} · ${TalkController._humanBytes(selected.byteCount)}',
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
              final isSelected = selected?.identityKey == artifact.identityKey;
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
                    artifact.kind == 'terminal'
                        ? Icons.terminal_rounded
                        : artifact.kind == 'computer'
                        ? Icons.screenshot_monitor_outlined
                        : artifact.isPresentation
                        ? Icons.slideshow_rounded
                        : artifact.kind == 'image'
                        ? Icons.image_outlined
                        : Icons.movie_outlined,
                    color: isSelected ? scheme.primary : null,
                  ),
                  title: Text(
                    artifact.title ?? artifact.filename,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(
                    artifact.isPresentation
                        ? '${artifact.slideCount == null ? 'PowerPoint' : '${artifact.slideCount} slides'} · Private · ${TalkController._sentenceCase(artifact.status)}'
                        : '${artifact.contextLabel ?? TalkController._sentenceCase(artifact.operation)} · ${artifact.status}',
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
            artifact.kind == 'terminal'
                ? Icons.terminal_rounded
                : artifact.kind == 'computer'
                ? Icons.screenshot_monitor_outlined
                : artifact.isPresentation
                ? Icons.slideshow_rounded
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
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      controller.queuePaused
                          ? 'Paused for review'
                          : controller.sending
                          ? 'Runs after the current prompt'
                          : 'Synced queue · runs in this order',
                      style: TextStyle(
                        color: scheme.onSurfaceVariant,
                        fontSize: 11.5,
                      ),
                    ),
                  ),
                  if (controller.promptQueueSyncing)
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 8),
                      child: SizedBox.square(
                        dimension: 14,
                        child: CircularProgressIndicator(strokeWidth: 1.8),
                      ),
                    )
                  else
                    IconButton(
                      tooltip: 'Refresh synced queue',
                      visualDensity: VisualDensity.compact,
                      onPressed: controller.reconcilePromptQueue,
                      icon: const Icon(Icons.sync_rounded, size: 17),
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
              if (controller.promptQueueError != null)
                Text(
                  'Some queue changes need review after reconnecting.',
                  style: TextStyle(
                    color: scheme.error,
                    fontSize: 10.5,
                    fontWeight: FontWeight.w600,
                  ),
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
                              Wrap(
                                spacing: 6,
                                runSpacing: 5,
                                children: [
                                  _QueueStatusChip(
                                    label: TalkController._sentenceCase(
                                      prompt.state,
                                    ),
                                    color: prompt.state == 'failed'
                                        ? scheme.error
                                        : prompt.state == 'completed'
                                        ? scheme.primary
                                        : prompt.state == 'dispatching'
                                        ? scheme.tertiary
                                        : scheme.onSurfaceVariant,
                                  ),
                                  if (prompt.syncState !=
                                      TalkPromptQueueSyncState.synced)
                                    _QueueStatusChip(
                                      label:
                                          prompt.syncState ==
                                              TalkPromptQueueSyncState.conflict
                                          ? 'Review conflict'
                                          : 'Sync pending',
                                      color:
                                          prompt.syncState ==
                                              TalkPromptQueueSyncState.conflict
                                          ? scheme.error
                                          : scheme.tertiary,
                                    ),
                                  if (prompt.providerId != null &&
                                      prompt.modelId != null)
                                    _QueueStatusChip(
                                      label:
                                          '${prompt.providerId} · ${prompt.modelId}',
                                      color: scheme.onSurfaceVariant,
                                    ),
                                  if (prompt.agentDefinitionVersion != null)
                                    _QueueStatusChip(
                                      label:
                                          'Agent v${prompt.agentDefinitionVersion}',
                                      color: scheme.onSurfaceVariant,
                                    ),
                                  if (prompt.contextReferences.isNotEmpty)
                                    _QueueStatusChip(
                                      label:
                                          '${prompt.contextReferences.length} context ${prompt.contextReferences.length == 1 ? 'item' : 'items'}',
                                      color: scheme.onSurfaceVariant,
                                    ),
                                ],
                              ),
                              if (prompt.progressLabel != null ||
                                  prompt.failureCode != null) ...[
                                const SizedBox(height: 6),
                                Text(
                                  prompt.progressLabel ??
                                      'Stopped · ${prompt.failureCode}',
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    color: prompt.failureCode == null
                                        ? scheme.onSurfaceVariant
                                        : scheme.error,
                                    fontSize: 10.5,
                                    height: 1.3,
                                  ),
                                ),
                              ],
                              const SizedBox(height: 4),
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
                                      prompt.assignedAgent == null
                                          ? prompt.executionTarget.label
                                          : '${prompt.assignedAgent!.name} · ${TalkController._sentenceCase(prompt.strategy)} · ${prompt.executionTarget.label}',
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
                                    onPressed: prompt.editable
                                        ? () => _editPrompt(prompt)
                                        : null,
                                    icon: const Icon(
                                      Icons.edit_outlined,
                                      size: 17,
                                    ),
                                  ),
                                  IconButton(
                                    tooltip:
                                        prompt.state == 'paused' ||
                                            prompt.state == 'failed'
                                        ? 'Resume prompt'
                                        : 'Pause prompt',
                                    visualDensity: VisualDensity.compact,
                                    onPressed:
                                        const {
                                          'queued',
                                          'paused',
                                          'failed',
                                        }.contains(prompt.state)
                                        ? () =>
                                              controller.setQueuedPromptPaused(
                                                prompt.id,
                                                paused:
                                                    prompt.state == 'queued',
                                              )
                                        : null,
                                    icon: Icon(
                                      prompt.state == 'paused' ||
                                              prompt.state == 'failed'
                                          ? Icons.play_circle_outline_rounded
                                          : Icons.pause_circle_outline_rounded,
                                      size: 18,
                                    ),
                                  ),
                                  IconButton(
                                    tooltip: controller.sending
                                        ? 'Make this next'
                                        : 'Run now',
                                    visualDensity: VisualDensity.compact,
                                    onPressed:
                                        const {
                                          'queued',
                                          'paused',
                                        }.contains(prompt.state)
                                        ? () => controller.runQueuedPrompt(
                                            prompt.id,
                                          )
                                        : null,
                                    icon: const Icon(
                                      Icons.play_arrow_rounded,
                                      size: 19,
                                    ),
                                  ),
                                  IconButton(
                                    tooltip: 'Remove prompt',
                                    visualDensity: VisualDensity.compact,
                                    onPressed: prompt.state == 'dispatching'
                                        ? null
                                        : () => controller.removeQueuedPrompt(
                                            prompt.id,
                                          ),
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

class _QueueStatusChip extends StatelessWidget {
  const _QueueStatusChip({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(maxWidth: 230),
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
    decoration: BoxDecoration(
      color: color.withValues(alpha: 0.09),
      borderRadius: BorderRadius.circular(999),
      border: Border.all(color: color.withValues(alpha: 0.22)),
    ),
    child: Text(
      label,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(
        color: color,
        fontSize: 9.5,
        fontWeight: FontWeight.w700,
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

bool _isTechnicalTalkActivity(TalkActivity activity) =>
    activity.key == 'harness' || activity.key.startsWith('model:');

String _humanCommandStatus(String value) =>
    switch (value.trim().toLowerCase()) {
      'connecting' => 'Getting everything ready…',
      'working' => 'Working on your request…',
      'queued' => 'Your request is lined up',
      'resuming' => 'Continuing where Asael left off…',
      'transcribing voice draft' => 'Writing your voice draft…',
      'delegated' => 'Specialists are continuing in the background',
      _ => value,
    };

String _humanActivityTitle(TalkActivity activity) {
  final key = activity.key.toLowerCase();
  final title = activity.title.toLowerCase();
  if (key.startsWith('tool:')) {
    if (title.contains('knowledge')) return 'Searched your knowledge';
    if (title.contains('memory')) return 'Searched your memory';
    if (title.contains('web') || title.contains('search')) {
      return 'Searched the web';
    }
    if (title.contains('runs.list') || title.contains('recent run')) {
      return 'Checked recent work';
    }
    if (title.contains('local.macos.observe') || title.contains('screenshot')) {
      return 'Looked at this Mac';
    }
    if (title.contains('local.macos') || title.contains('computer')) {
      return 'Used this Mac';
    }
    if (title.contains('gmail') || title.contains('email')) {
      return 'Worked with your email';
    }
    if (title.contains('calendar')) return 'Checked your calendar';
    if (title.contains('drive') ||
        title.contains('docs') ||
        title.contains('sheets') ||
        title.contains('slides')) {
      return 'Worked in Google Workspace';
    }
    if (activity.title.contains('.') || activity.title.contains('_')) {
      return 'Used a connected capability';
    }
  }
  if (key == 'council-verdict') {
    return activity.state == TalkActivityState.failed
        ? 'Could not verify the specialists’ result'
        : 'Checked the specialists’ work';
  }
  if (key == 'run') return 'Asael';
  if (key == 'status' && title == 'response ready') return 'Result ready';
  return activity.title;
}

String _humanActivityDetail(TalkActivity activity) => switch (activity.detail
    .trim()) {
  'Started a governed run.' => 'Started working on your request.',
  'Response completed.' => 'Finished the answer.',
  'The governed run reached a terminal response.' => 'Your result is ready.',
  'The accepted governed run is in progress.' =>
    'Your request is moving forward.',
  'A governed cancellation request was sent.' =>
    'Asael is stopping this work safely.',
  'Waiting for the run to confirm its terminal state.' =>
    'Waiting for the work to stop.',
  _ => activity.detail,
};

class _CommandLiveGlyph extends StatelessWidget {
  const _CommandLiveGlyph();

  @override
  Widget build(BuildContext context) =>
      const AsaelMascot(state: AsaelMascotState.working, size: 26);
}

class _ActivityStoryGlyph extends StatefulWidget {
  const _ActivityStoryGlyph({
    required this.icon,
    required this.color,
    required this.active,
  });

  final IconData icon;
  final Color? color;
  final bool active;
  final double size = 28;

  @override
  State<_ActivityStoryGlyph> createState() => _ActivityStoryGlyphState();
}

class _ActivityStoryGlyphState extends State<_ActivityStoryGlyph>
    with SingleTickerProviderStateMixin {
  late final AnimationController controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1600),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncAnimation();
  }

  @override
  void didUpdateWidget(covariant _ActivityStoryGlyph oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.active != widget.active) _syncAnimation();
  }

  void _syncAnimation() {
    if (widget.active && !MediaQuery.disableAnimationsOf(context)) {
      if (!controller.isAnimating) controller.repeat(reverse: true);
    } else {
      controller.stop();
      controller.value = widget.active ? .5 : 0;
    }
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final resolvedColor = widget.color ?? Theme.of(context).colorScheme.primary;
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final pulse = widget.active ? controller.value : 0.0;
        return SizedBox.square(
          dimension: widget.size,
          child: Stack(
            alignment: Alignment.center,
            children: [
              if (widget.active)
                Container(
                  width: widget.size * (.72 + pulse * .2),
                  height: widget.size * (.72 + pulse * .2),
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: resolvedColor.withValues(alpha: .2 + pulse * .18),
                    ),
                  ),
                ),
              Container(
                width: widget.size * .72,
                height: widget.size * .72,
                decoration: BoxDecoration(
                  color: resolvedColor.withValues(alpha: .12),
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  widget.icon,
                  size: widget.size * .46,
                  color: resolvedColor,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _TalkActivityCard extends StatelessWidget {
  const _TalkActivityCard({required this.activity, required this.technical});

  final TalkActivity activity;
  final bool technical;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (icon, color) = switch (activity.state) {
      TalkActivityState.active => (Icons.auto_awesome_rounded, scheme.primary),
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
    final title = technical ? activity.title : _humanActivityTitle(activity);
    final detail = technical ? activity.detail : _humanActivityDetail(activity);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: technical
            ? scheme.surfaceContainerLowest.withValues(alpha: .7)
            : scheme.surfaceContainerLow.withValues(alpha: .9),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant.withValues(alpha: .8)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: _ActivityStoryGlyph(
              icon: icon,
              color: color,
              active: activity.state == TalkActivityState.active,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        title,
                        style: const TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    if (technical)
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 6,
                          vertical: 2,
                        ),
                        decoration: BoxDecoration(
                          color: scheme.surfaceContainerHigh,
                          borderRadius: BorderRadius.circular(5),
                        ),
                        child: Text(
                          'TECHNICAL',
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(fontSize: 8.5, letterSpacing: .45),
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 3),
                Text(
                  detail,
                  maxLines: technical ? 5 : 4,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    fontSize: 11.5,
                    height: 1.35,
                  ),
                ),
                if (activity.actionLabel != null &&
                    (activity.actionRoute != null ||
                        activity.externalUri != null)) ...[
                  const SizedBox(height: 7),
                  Row(
                    children: [
                      TextButton.icon(
                        onPressed: () => _activate(context),
                        icon: Icon(
                          activity.externalUri == null
                              ? Icons.arrow_forward_rounded
                              : Icons.open_in_new_rounded,
                          size: 15,
                        ),
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
                      if (activity.actionRoute != null &&
                          appDesktopHostBridge.supported &&
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

  Future<void> _activate(BuildContext context) async {
    final route = activity.actionRoute;
    if (route != null) {
      context.go(route);
      return;
    }
    final uri = activity.externalUri;
    if (uri == null) return;
    var opened = false;
    try {
      opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      opened = false;
    }
    if (opened || !context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Asael could not open this Google Workspace file.'),
      ),
    );
  }
}

class _TalkEmpty extends StatelessWidget {
  const _TalkEmpty({required this.selectedThread, required this.loading});

  final bool selectedThread;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final macos = usesMacosPresentation();
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (macos)
              AsaelMascot(
                state: loading
                    ? AsaelMascotState.working
                    : AsaelMascotState.ready,
                size: 132,
              )
            else if (loading)
              const SizedBox.square(
                dimension: 38,
                child: CircularProgressIndicator(strokeWidth: 2.5),
              )
            else
              const AsaelMark(size: 52),
            SizedBox(height: macos ? 14 : 20),
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
                  ? macos
                        ? 'Bringing your latest messages back into view.'
                        : 'Reading the latest public message projection.'
                  : selectedThread
                  ? 'Send a message to continue this durable conversation.'
                  : macos
                  ? 'Ask naturally. Asael can work alone, bring in specialists, or use this Mac when you choose.'
                  : 'Ask a question or describe an outcome. Asael will keep plans, evidence, and approvals connected.',
              textAlign: TextAlign.center,
              style: macos
                  ? TextStyle(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    )
                  : null,
            ),
          ],
        ),
      ),
    );
  }
}
