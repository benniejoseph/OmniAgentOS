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

class ResultsSnapshot {
  const ResultsSnapshot({
    required this.items,
    required this.evaluations,
    required this.sourceErrors,
  });
  final List<ResultItem> items;
  final List<EvaluationResult> evaluations;
  final List<String> sourceErrors;
}

abstract interface class ResultsRepository {
  Future<ResultsSnapshot> list();
  Future<ResultItem?> detail(String key);
  Future<void> cancel(String runId);
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
}
