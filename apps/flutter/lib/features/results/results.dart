import 'package:flutter/foundation.dart';

import 'result_contracts.dart';
import 'result_projection.dart';
import '../talk/talk_research.dart';
export 'results_controller.dart' show ResultsController;

typedef Json = Map<String, dynamic>;

enum ResultKind { agent, workflow, approval }

enum ResultTone { neutral, success, warning, danger }

class ResultItem {
  const ResultItem({
    required this.key,
    required this.kind,
    required this.title,
    required this.status,
    required this.body,
    required this.meta,
    required this.tone,
    this.timestamp,
    this.groundingStatus = 'unavailable',
    this.evidence = const [],
    this.metadata = const {},
    this.canonical,
    this.approvalKind,
    this.threadId,
    this.research,
  });
  final String key, title, status, body, meta, groundingStatus;
  final ResultKind kind;
  final ResultTone tone;
  final DateTime? timestamp;
  final List<String> evidence;
  final Map<String, String> metadata;
  final ResultCanonical? canonical;
  final String? approvalKind, threadId;
  final TalkResearchWorkflow? research;
  String get selectionIdentity =>
      kind == ResultKind.approval ? '$key:$approvalKind' : key;
  bool get canCancel =>
      kind == ResultKind.agent &&
      const {
        'queued',
        'running',
        'waiting_approval',
        'waiting_clarification',
        'resuming',
      }.contains(status);

  /// Citation verification does not prove the requested outcome succeeded.
  bool get verified => groundingStatus == 'verified';
  bool get verifiedOutcome => canonical?.status == 'succeeded';
  String get statusLabel =>
      canonical?.label ??
      (status == 'completed'
          ? 'Completed · outcome unverified'
          : status.replaceAll('_', ' '));
  String get groundingLabel => kind == ResultKind.workflow
      ? 'Returned verification: $groundingStatus'
      : switch (groundingStatus) {
          'verified' => 'Citations verified',
          'missing' => 'Citation needed',
          'invalid' => 'Invalid citation',
          'not_required' => 'No retrieved sources required',
          'unavailable' => 'Grounding unavailable',
          _ => 'Grounding: $groundingStatus',
        };
  static ResultTone toneFor(String status) => switch (status) {
    'succeeded' => ResultTone.success,
    'waiting_approval' ||
    'waiting_clarification' ||
    'queued' ||
    'running' ||
    'resuming' ||
    'paused' ||
    'pending' ||
    'partial' => ResultTone.warning,
    'failed' ||
    'blocked' ||
    'denied' ||
    'rejected' ||
    'error' ||
    'timed_out' => ResultTone.danger,
    _ => ResultTone.neutral,
  };
  factory ResultItem._parsed(
    ParsedResult value, {
    TalkResearchWorkflow? research,
  }) => ResultItem(
    key: value.key.value,
    kind: ResultKind.values.byName(value.key.kind),
    title: value.title,
    status: value.status,
    body: research?.report?.markdown ?? value.body,
    meta: value.meta,
    tone: toneFor(value.canonical?.status ?? value.status),
    timestamp: value.timestamp,
    groundingStatus: value.grounding,
    evidence: value.evidence,
    metadata: value.metadata,
    canonical: value.canonical,
    approvalKind: value.approvalKind,
    threadId: value.threadId ?? research?.threadId,
    research: research,
  );
  factory ResultItem.agent(Json value) => ResultItem._parsed(
    ParsedResult.agent(value),
    research: TalkResearchWorkflow.fromAgentRun(value),
  );
  factory ResultItem.workflow(Json value) => ResultItem._parsed(
    ParsedResult.workflow(value),
    research: TalkResearchWorkflow.fromDetail({
      'run': value,
      'steps': value['steps'],
    }),
  );
  factory ResultItem.approval(Json value) =>
      ResultItem._parsed(ParsedResult.approval(value));
}

class EvaluationResult {
  const EvaluationResult({
    required this.id,
    required this.suite,
    required this.status,
    required this.passed,
    required this.total,
  });
  final String id, suite, status;
  final int? passed, total;
  String get countLabel => passed == null || total == null
      ? 'Counts unavailable'
      : '$passed / $total passed';
  factory EvaluationResult.fromJson(Json value) {
    final summary = value['summary'] == null
        ? null
        : resultRecord(value['summary']);
    final passed = summary?['passed'] == null
        ? null
        : resultCount(summary?['passed']);
    final total = summary?['total'] == null
        ? null
        : resultCount(summary?['total']);
    resultRequire(passed == null || total == null || passed <= total);
    return EvaluationResult(
      id: resultText(value['id'], maximum: 200),
      suite: resultText(value['suite']),
      status: resultText(value['status'], maximum: 160),
      passed: passed,
      total: total,
    );
  }
}

enum GeneratedArtifactKind { document, presentation, spreadsheet, pdf }

enum GeneratedArtifactStatus { queued, rendering, ready, failed }

class GeneratedArtifactSummary {
  const GeneratedArtifactSummary({
    required this.id,
    required this.kind,
    required this.title,
    required this.filename,
    required this.version,
    required this.status,
    required this.mediaType,
    required this.byteCount,
    required this.createdAt,
    required this.updatedAt,
    required this.queuedAt,
    required this.readyAt,
    required this.failedAt,
  });

  final String id;
  final GeneratedArtifactKind kind;
  final String title;
  final String filename;
  final int version;
  final GeneratedArtifactStatus status;
  final String mediaType;
  final int? byteCount;
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime queuedAt;
  final DateTime? readyAt;
  final DateTime? failedAt;

  bool get ready =>
      status == GeneratedArtifactStatus.ready && byteCount != null;

  static GeneratedArtifactSummary? tryParse(Object? value) {
    final artifact = value is Map
        ? Map<String, dynamic>.from(value)
        : const <String, dynamic>{};
    final current = artifact['current'] is Map
        ? Map<String, dynamic>.from(artifact['current'] as Map)
        : const <String, dynamic>{};
    final id = _exactArtifactText(artifact['id'], 67);
    final title = _exactArtifactText(artifact['title'], 240);
    final filename = _exactArtifactText(artifact['filename'], 240);
    final kind = _generatedArtifactKind(artifact['kind']);
    final status = _generatedArtifactStatus(current['status']);
    final currentVersion = _positiveArtifactInteger(artifact['currentVersion']);
    final version = _positiveArtifactInteger(current['version']);
    final mediaType = _exactArtifactText(current['mediaType'], 160);
    final byteCountValue = current['byteCount'];
    final byteCount = byteCountValue == null
        ? null
        : _artifactByteCount(byteCountValue);
    final createdAt = _exactArtifactTimestamp(artifact['createdAt']);
    final updatedAt = _exactArtifactTimestamp(artifact['updatedAt']);
    final queuedAt = _exactArtifactTimestamp(current['queuedAt']);
    final readyAt = current['readyAt'] == null
        ? null
        : _exactArtifactTimestamp(current['readyAt']);
    final failedAt = current['failedAt'] == null
        ? null
        : _exactArtifactTimestamp(current['failedAt']);
    if (id == null ||
        !RegExp(r'^generated_artifact_[a-f0-9]{48}$').hasMatch(id) ||
        title == null ||
        filename == null ||
        kind == null ||
        status == null ||
        currentVersion == null ||
        version == null ||
        currentVersion != version ||
        mediaType == null ||
        mediaType != _generatedArtifactMediaType(kind) ||
        !_generatedArtifactFilenameMatches(filename, kind) ||
        createdAt == null ||
        updatedAt == null ||
        queuedAt == null ||
        (byteCountValue != null && byteCount == null) ||
        (current['readyAt'] != null && readyAt == null) ||
        (current['failedAt'] != null && failedAt == null) ||
        updatedAt.isBefore(createdAt) ||
        queuedAt.isBefore(createdAt)) {
      return null;
    }
    final validState = switch (status) {
      GeneratedArtifactStatus.ready =>
        byteCount != null && readyAt != null && failedAt == null,
      GeneratedArtifactStatus.failed =>
        byteCount == null && readyAt == null && failedAt != null,
      GeneratedArtifactStatus.queued || GeneratedArtifactStatus.rendering =>
        byteCount == null && readyAt == null && failedAt == null,
    };
    if (!validState ||
        (readyAt != null && readyAt.isBefore(queuedAt)) ||
        (failedAt != null && failedAt.isBefore(queuedAt))) {
      return null;
    }
    return GeneratedArtifactSummary(
      id: id,
      kind: kind,
      title: title,
      filename: filename,
      version: version,
      status: status,
      mediaType: mediaType,
      byteCount: byteCount,
      createdAt: createdAt,
      updatedAt: updatedAt,
      queuedAt: queuedAt,
      readyAt: readyAt,
      failedAt: failedAt,
    );
  }
}

String? _exactArtifactText(Object? value, int maximum) {
  if (value is! String ||
      value.isEmpty ||
      value.length > maximum ||
      value.trim() != value ||
      RegExp(r'[\u0000-\u001F\u007F]').hasMatch(value)) {
    return null;
  }
  return value;
}

int? _positiveArtifactInteger(Object? value) =>
    value is int && value >= 1 && value <= 2_147_483_647 ? value : null;

int? _artifactByteCount(Object? value) =>
    value is int && value >= 1 && value <= 64 * 1024 * 1024 ? value : null;

DateTime? _exactArtifactTimestamp(Object? value) {
  if (value is! String ||
      value.length > 40 ||
      !RegExp(
        r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$',
      ).hasMatch(value)) {
    return null;
  }
  return DateTime.tryParse(value)?.toUtc();
}

GeneratedArtifactKind? _generatedArtifactKind(Object? value) => switch (value) {
  'document' => GeneratedArtifactKind.document,
  'presentation' => GeneratedArtifactKind.presentation,
  'spreadsheet' => GeneratedArtifactKind.spreadsheet,
  'pdf' => GeneratedArtifactKind.pdf,
  _ => null,
};

GeneratedArtifactStatus? _generatedArtifactStatus(Object? value) =>
    switch (value) {
      'queued' => GeneratedArtifactStatus.queued,
      'rendering' => GeneratedArtifactStatus.rendering,
      'ready' => GeneratedArtifactStatus.ready,
      'failed' => GeneratedArtifactStatus.failed,
      _ => null,
    };

String _generatedArtifactMediaType(
  GeneratedArtifactKind kind,
) => switch (kind) {
  GeneratedArtifactKind.document =>
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  GeneratedArtifactKind.presentation =>
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  GeneratedArtifactKind.spreadsheet =>
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  GeneratedArtifactKind.pdf => 'application/pdf',
};

bool _generatedArtifactFilenameMatches(
  String filename,
  GeneratedArtifactKind kind,
) {
  if (filename.contains('/') || filename.contains(r'\')) {
    return false;
  }
  final extension = switch (kind) {
    GeneratedArtifactKind.document => '.docx',
    GeneratedArtifactKind.presentation => '.pptx',
    GeneratedArtifactKind.spreadsheet => '.xlsx',
    GeneratedArtifactKind.pdf => '.pdf',
  };
  return filename.toLowerCase().endsWith(extension) &&
      filename.length > extension.length;
}

class ResultsSnapshot {
  const ResultsSnapshot({
    required this.items,
    required this.evaluations,
    required this.sourceErrors,
    this.createdFiles = const [],
  });
  final List<ResultItem> items;
  final List<EvaluationResult> evaluations;
  final List<String> sourceErrors;
  final List<GeneratedArtifactSummary> createdFiles;
}

class GeneratedArtifactsSnapshot {
  const GeneratedArtifactsSnapshot({required this.files, this.sourceError});

  final List<GeneratedArtifactSummary> files;
  final String? sourceError;
}

abstract interface class ResultsRepository {
  Future<ResultsSnapshot> list();
  Future<ResultItem?> detail(String key);
  Future<void> cancel(String runId);
}

abstract interface class ProgressiveResultsRepository {
  Future<ResultsSnapshot> listPrimary();
  Future<GeneratedArtifactsSnapshot> listGeneratedArtifacts();
}

abstract interface class GeneratedArtifactResultsRepository {
  Future<Uint8List> downloadGeneratedArtifact(
    GeneratedArtifactSummary artifact,
  );
}
