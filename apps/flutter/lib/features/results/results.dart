import 'package:flutter/foundation.dart';

typedef Json = Map<String, dynamic>;
String _s(Object? v, [String fallback = '']) =>
    v == null ? fallback : v.toString();
Json _map(Object? v) =>
    v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
Object? _path(Object? source, String path) {
  Object? value = source;
  for (final key in path.split('.')) {
    value = _map(value)[key];
  }
  return value;
}

DateTime? _firstDate(List<Object?> values) {
  for (final v in values) {
    final d = DateTime.tryParse(_s(v));
    if (d != null) return d;
  }
  return null;
}

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
  });
  final String key, title, status, body, meta, groundingStatus;
  final ResultKind kind;
  final ResultTone tone;
  final DateTime? timestamp;
  final List<String> evidence;
  bool get canCancel =>
      kind == ResultKind.agent &&
      const {
        'running',
        'waiting_approval',
        'resuming',
      }.contains(status.toLowerCase());
  bool get verified => groundingStatus == 'verified';
  static ResultTone toneFor(String status) {
    final s = status.toLowerCase();
    if (const {
      'healthy',
      'passed',
      'success',
      'completed',
      'executed',
      'approved',
      'ready',
    }.contains(s)) {
      return ResultTone.success;
    }
    if (const {
      'warning',
      'waiting_approval',
      'queued',
      'running',
      'paused',
      'pending',
      'degraded',
      'dry_run',
    }.contains(s)) {
      return ResultTone.warning;
    }
    if (const {
      'error',
      'failed',
      'blocked',
      'denied',
      'unhealthy',
      'rejected',
      'timeout',
      'timed_out',
      'open',
    }.contains(s)) {
      return ResultTone.danger;
    }
    return ResultTone.neutral;
  }

  factory ResultItem.agent(Json j) {
    final status = _s(j['status'], 'unknown'),
        grounding = _map(j['grounding']),
        groundingStatus = _s(grounding['status'], 'unavailable'),
        at = _firstDate([
          j['completedAt'],
          j['updatedAt'],
          j['startedAt'],
          j['createdAt'],
        ]);
    final refs =
        ((grounding['citations'] ?? grounding['sources']) as List? ?? const [])
            .map((e) => _s(_map(e)['url'], _s(e)))
            .where((e) => e.isNotEmpty)
            .toList();
    return ResultItem(
      key: 'agent:${_s(j['id'])}',
      kind: ResultKind.agent,
      title: _s(j['prompt'], 'Agent run'),
      status: status,
      body: _s(
        j['response'] ?? j['error'],
        _terminal(status)
            ? 'No result text was stored.'
            : 'Execution is still in progress.',
      ),
      meta: '${_s(j['mode'], 'agent')} · ${_grounding(groundingStatus)}',
      tone: toneFor(status),
      timestamp: at,
      groundingStatus: groundingStatus,
      evidence: refs,
    );
  }
  factory ResultItem.workflow(Json j) {
    final status = _s(j['status'], 'unknown'),
        at = _firstDate([j['completedAt'], j['updatedAt'], j['createdAt']]);
    return ResultItem(
      key: 'workflow:${_s(j['id'])}',
      kind: ResultKind.workflow,
      title: _s(j['goal'], 'Workflow'),
      status: status,
      body: _s(
        _path(j, 'result.report') ?? j['error'],
        _terminal(status)
            ? 'No final report was stored.'
            : 'Workflow is still in progress.',
      ),
      meta: _s(j['currentStep'], 'workflow'),
      tone: toneFor(status),
      timestamp: at,
      evidence: (((_path(j, 'result.evidenceRefs') as List?) ?? const [])
          .map(_s)
          .toList()),
      groundingStatus: _s(
        _path(j, 'result.verification.status'),
        'unavailable',
      ),
    );
  }
  factory ResultItem.approval(Json j) {
    final status = _s(j['status'], 'waiting_approval');
    return ResultItem(
      key: 'approval:${_s(j['id'])}',
      kind: ResultKind.approval,
      title: _s(j['title'], 'Approval required'),
      status: status,
      body: _s(
        j['reason'] ?? _path(j, 'record.error'),
        'Work is paused for operator review.',
      ),
      meta:
          '${_s(j['kind'], 'approval')} · risk ${_s(j['riskLevel'], 'unknown')}',
      tone: toneFor(status),
      timestamp: _firstDate([j['updatedAt'], j['createdAt']]),
    );
  }
  static bool _terminal(String s) => const {
    'completed',
    'failed',
    'blocked',
    'rejected',
    'canceled',
    'timeout',
    'timed_out',
  }.contains(s.toLowerCase());
  static String _grounding(String s) => s == 'verified'
      ? 'citations verified'
      : s == 'missing'
      ? 'citation needed'
      : s == 'invalid'
      ? 'invalid citation'
      : s == 'not_required'
      ? 'no retrieved sources'
      : 'grounding unavailable';
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
  final int passed, total;
  factory EvaluationResult.fromJson(Json j) => EvaluationResult(
    id: _s(j['id']),
    suite: _s(j['suite'], 'Evaluation suite'),
    status: _s(j['status'], 'unknown'),
    passed: (_path(j, 'summary.passed') as num?)?.toInt() ?? 0,
    total: (_path(j, 'summary.total') as num?)?.toInt() ?? 0,
  );
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
  if (filename.contains('/') || filename.contains(r'\')) return false;
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

abstract interface class ResultsRepository {
  Future<ResultsSnapshot> list();
  Future<ResultItem?> detail(String key);
  Future<void> cancel(String runId);
}

abstract interface class GeneratedArtifactResultsRepository {
  Future<Uint8List> downloadGeneratedArtifact(
    GeneratedArtifactSummary artifact,
  );
}

class ResultsController extends ChangeNotifier {
  ResultsController(this.repository);
  final ResultsRepository repository;
  ResultsSnapshot? snapshot;
  bool loading = false;
  Object? error;
  String query = '';
  ResultKind? kind;
  String? status;
  Future<void> refresh() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      snapshot = await repository.list();
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  void filter({
    String? search,
    ResultKind? resultKind,
    String? resultStatus,
    bool clearKind = false,
  }) {
    if (search != null) query = search;
    if (clearKind) {
      kind = null;
    } else if (resultKind != null) {
      kind = resultKind;
    }
    if (resultStatus != null) {
      status = resultStatus.isEmpty ? null : resultStatus;
    }
    notifyListeners();
  }

  List<ResultItem> get filtered {
    final q = query.toLowerCase();
    return (snapshot?.items ?? const [])
        .where(
          (r) =>
              (kind == null || r.kind == kind) &&
              (status == null || r.status == status) &&
              (q.isEmpty ||
                  r.title.toLowerCase().contains(q) ||
                  r.body.toLowerCase().contains(q)),
        )
        .toList();
  }

  Future<Uint8List> downloadCreatedFile(GeneratedArtifactSummary artifact) {
    final source = repository is GeneratedArtifactResultsRepository
        ? repository as GeneratedArtifactResultsRepository
        : null;
    if (source == null) {
      throw StateError('Generated file downloads are unavailable.');
    }
    if (!artifact.ready) {
      throw StateError('This generated file is not ready to download.');
    }
    return source.downloadGeneratedArtifact(artifact);
  }
}
