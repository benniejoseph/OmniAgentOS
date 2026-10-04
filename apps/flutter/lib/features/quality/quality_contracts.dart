/// Bounded, read-only projections of the existing Quality response contracts.
/// These models deliberately retain no case inputs, job payloads, gate details,
/// or other unstructured operational data.
library;

enum QualityRunStatus {
  running('running', 'Running'),
  completed('completed', 'Completed'),
  failed('failed', 'Failed');

  const QualityRunStatus(this.wireValue, this.label);
  final String wireValue, label;
}

enum QualityJobStatus {
  queued('queued', 'Queued'),
  running('running', 'Running'),
  completed('completed', 'Completed'),
  failed('failed', 'Failed'),
  canceled('canceled', 'Canceled');

  const QualityJobStatus(this.wireValue, this.label);
  final String wireValue, label;
}

enum QualityCaseType {
  system('system', 'System'),
  retrieval('retrieval', 'Retrieval'),
  tool('tool', 'Tool'),
  workflow('workflow', 'Workflow'),
  security('security', 'Security'),
  operations('operations', 'Operations');

  const QualityCaseType(this.wireValue, this.label);
  final String wireValue, label;
}

enum QualitySafetyMode {
  readOnly('read_only', 'Read only'),
  synthetic('synthetic', 'Synthetic'),
  mutationAllowed('mutation_allowed', 'Mutation allowed');

  const QualitySafetyMode(this.wireValue, this.label);
  final String wireValue, label;
}

enum QualityCleanupPolicy {
  none('none', 'None'),
  selfCleaning('self_cleaning', 'Self cleaning'),
  auditRetained('audit_retained', 'Audit retained'),
  manualReview('manual_review', 'Manual review');

  const QualityCleanupPolicy(this.wireValue, this.label);
  final String wireValue, label;
}

enum QualityReleaseStatus {
  passed('passed', 'Passed'),
  warning('warning', 'Warning'),
  blocked('blocked', 'Blocked');

  const QualityReleaseStatus(this.wireValue, this.label);
  final String wireValue, label;
}

enum QualityGateStatus {
  pass('pass', 'Pass'),
  warn('warn', 'Warning'),
  fail('fail', 'Fail');

  const QualityGateStatus(this.wireValue, this.label);
  final String wireValue, label;
}

void _require(bool valid) {
  if (!valid) {
    throw const FormatException('Quality returned an invalid response.');
  }
}

Map<String, dynamic> _object(Object? value) {
  _require(value is Map<String, dynamic>);
  return value as Map<String, dynamic>;
}

String _text(Object? value, int maximum, {bool empty = false}) {
  _require(
    value is String &&
        value.length <= maximum &&
        (empty || value.trim().isNotEmpty),
  );
  return value as String;
}

String? _optionalText(Object? value, int maximum) =>
    value == null ? null : _text(value, maximum, empty: true);

bool _boolean(Object? value) {
  _require(value is bool);
  return value as bool;
}

int _count(Object? value, {int maximum = 1000000, int minimum = 0}) {
  _require(value is int && value >= minimum && value <= maximum);
  return value as int;
}

double _number(Object? value, double maximum) {
  _require(value is num && value.isFinite && value >= 0 && value <= maximum);
  return (value as num).toDouble();
}

DateTime _instant(Object? value) {
  final text = _text(value, 40);
  final match = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$',
  ).firstMatch(text);
  final date = DateTime.tryParse(text);
  _require(match != null && date != null);
  // DateTime.parse normalizes impossible dates and times; evidence must not.
  _require(
    date!.year >= 1970 &&
        date.year <= 9999 &&
        date.year == int.parse(match![1]!) &&
        date.month == int.parse(match[2]!) &&
        date.day == int.parse(match[3]!) &&
        date.hour == int.parse(match[4]!) &&
        date.minute == int.parse(match[5]!) &&
        date.second == int.parse(match[6]!),
  );
  return date.toUtc();
}

DateTime? _optionalInstant(Object? value) =>
    value == null ? null : _instant(value);

List<T> _list<T>(Object? value, int maximum, T Function(Object?) parse) {
  _require(value is List && value.length <= maximum);
  return List<T>.unmodifiable((value as List).map(parse));
}

List<String> _texts(Object? value, int maximum, int textMaximum) =>
    _list(value, maximum, (item) => _text(item, textMaximum));

T _enum<T>(Object? value, Iterable<T> values, String Function(T) wireValue) {
  _require(value is String);
  for (final item in values) {
    if (wireValue(item) == value) return item;
  }
  throw const FormatException('Quality returned an unknown status.');
}

void _unique<T>(List<T> values, String Function(T) id) {
  _require(values.map(id).toSet().length == values.length);
}

String _tenant(Object? value, String expected) {
  final tenant = _text(value, 120);
  _require(tenant == expected);
  return tenant;
}

class QualityRunSummary {
  const QualityRunSummary({
    required this.total,
    required this.passed,
    required this.failed,
    required this.warnings,
    required this.averageLatencyMs,
    required this.estimatedCostUsd,
  });

  final int total, passed, failed, warnings;
  final double averageLatencyMs, estimatedCostUsd;

  /// A completed run is a lifecycle state, not an assertion that cases passed.
  double? get passRate => total == 0 ? null : passed / total;

  factory QualityRunSummary.parse(Object? value) {
    final row = _object(value);
    final total = _count(row['total']);
    final passed = _count(row['passed']);
    final failed = _count(row['failed']);
    final warnings = _count(row['warnings']);
    _require(passed + failed + warnings <= total);
    return QualityRunSummary(
      total: total,
      passed: passed,
      failed: failed,
      warnings: warnings,
      averageLatencyMs: _number(row['averageLatencyMs'], 31536000000),
      estimatedCostUsd: _number(row['estimatedCostUsd'], 1000000000),
    );
  }
}

class QualityRun {
  const QualityRun({
    required this.id,
    required this.tenantId,
    required this.suite,
    required this.status,
    required this.summary,
    required this.startedAt,
    required this.createdAt,
    required this.updatedAt,
    this.completedAt,
    this.error,
  });

  final String id, tenantId, suite;
  final QualityRunStatus status;
  final QualityRunSummary summary;
  final DateTime startedAt, createdAt, updatedAt;
  final DateTime? completedAt;
  final String? error;

  factory QualityRun.parse(Object? value, {required String tenantId}) {
    final row = _object(value);
    return QualityRun(
      id: _text(row['id'], 200),
      tenantId: _tenant(row['tenantId'], tenantId),
      suite: _text(row['suite'], 200),
      status: _enum(
        row['status'],
        QualityRunStatus.values,
        (item) => item.wireValue,
      ),
      summary: QualityRunSummary.parse(row['summary']),
      startedAt: _instant(row['startedAt']),
      createdAt: _instant(row['createdAt']),
      updatedAt: _instant(row['updatedAt']),
      completedAt: _optionalInstant(row['completedAt']),
      error: _optionalText(row['error'], 4000),
    );
  }
}

class QualityStats {
  const QualityStats({
    required this.total,
    required this.running,
    required this.completed,
    required this.failed,
    required this.latestPassRate,
    required this.averageLatencyMs,
    required this.estimatedCostUsd,
    this.latest,
  });

  /// The server samples at most the latest 100 runs; this is not a lifetime sum.
  final int total, running, completed, failed;
  final QualityRun? latest;
  final double? latestPassRate;
  final double averageLatencyMs, estimatedCostUsd;

  factory QualityStats.parse(Object? value, {required String tenantId}) {
    final row = _object(value);
    final total = _count(row['total'], maximum: 100);
    final statuses = _object(row['byStatus']);
    _require(
      statuses.keys.every(
        (key) => QualityRunStatus.values.any((item) => item.wireValue == key),
      ),
    );
    int statusCount(String key) =>
        _count(statuses.containsKey(key) ? statuses[key] : 0, maximum: 100);
    final running = statusCount('running');
    final completed = statusCount('completed');
    final failed = statusCount('failed');
    _require(running + completed + failed == total);
    final latest = row['latest'] == null
        ? null
        : QualityRun.parse(row['latest'], tenantId: tenantId);
    _require((total == 0) == (latest == null));
    final rate = _number(row['latestPassRate'], 1);
    final measuredRate = latest?.summary.passRate;
    _require((rate - (measuredRate ?? 0)).abs() < 0.000000001);
    return QualityStats(
      total: total,
      running: running,
      completed: completed,
      failed: failed,
      latest: latest,
      latestPassRate: measuredRate == null ? null : rate,
      averageLatencyMs: _number(row['averageLatencyMs'], 31536000000),
      estimatedCostUsd: _number(row['estimatedCostUsd'], 1000000000),
    );
  }
}

class QualityJob {
  const QualityJob({
    required this.id,
    required this.status,
    required this.quarantined,
    required this.attempt,
    required this.maxAttempts,
    required this.runAt,
    required this.createdAt,
    required this.updatedAt,
    this.completedAt,
    this.lastError,
    this.evalRunId,
  });

  final String id;
  final QualityJobStatus status;
  final bool quarantined;
  final int attempt, maxAttempts;
  final DateTime runAt, createdAt, updatedAt;
  final DateTime? completedAt;
  final String? lastError, evalRunId;

  factory QualityJob.parse(Object? value) {
    final row = _object(value);
    _require(row['type'] == 'evaluation.run');
    final status = _enum(
      row['status'],
      QualityJobStatus.values,
      (item) => item.wireValue,
    );
    final quarantined = row.containsKey('quarantined')
        ? _boolean(row['quarantined'])
        : false;
    _require(!quarantined || status == QualityJobStatus.failed);
    final maxAttempts = _count(row['maxAttempts'], minimum: 1, maximum: 10000);
    final attempt = _count(row['attempt'], maximum: maxAttempts);
    final result = row['result'] == null ? null : _object(row['result']);
    final runId = result?['evalRunId'];
    return QualityJob(
      id: _text(row['id'], 200),
      status: status,
      quarantined: quarantined,
      attempt: attempt,
      maxAttempts: maxAttempts,
      runAt: _instant(row['runAt']),
      createdAt: _instant(row['createdAt']),
      updatedAt: _instant(row['updatedAt']),
      completedAt: _optionalInstant(row['completedAt']),
      lastError: _optionalText(row['lastError'], 4000),
      evalRunId: runId == null ? null : _text(runId, 200),
    );
  }
}

class QualityCase {
  QualityCase({
    required this.id,
    required this.name,
    required this.description,
    required this.type,
    required this.safetyMode,
    required this.riskLevel,
    required this.writesToDatabase,
    required this.cleanup,
    required this.allowedByDefault,
    required this.requiresAdmin,
    required this.requiresMutationApproval,
    required List<String> notes,
  }) : notes = List.unmodifiable(notes);

  final String id, name, description;
  final QualityCaseType type;
  final QualitySafetyMode safetyMode;
  final int riskLevel;
  final bool writesToDatabase;
  final QualityCleanupPolicy cleanup;
  final bool allowedByDefault, requiresAdmin, requiresMutationApproval;
  final List<String> notes;

  factory QualityCase.parse(Object? value) {
    final row = _object(value);
    final governance = _object(row['governance']);
    final production = _object(governance['production']);
    return QualityCase(
      id: _text(row['id'], 200),
      name: _text(row['name'], 300),
      description: _text(row['description'], 4000, empty: true),
      type: _enum(
        row['type'],
        QualityCaseType.values,
        (item) => item.wireValue,
      ),
      safetyMode: _enum(
        governance['safetyMode'],
        QualitySafetyMode.values,
        (item) => item.wireValue,
      ),
      riskLevel: _count(governance['riskLevel'], maximum: 3),
      writesToDatabase: _boolean(governance['writesToDatabase']),
      cleanup: _enum(
        governance['cleanup'],
        QualityCleanupPolicy.values,
        (item) => item.wireValue,
      ),
      allowedByDefault: _boolean(production['allowedByDefault']),
      requiresAdmin: _boolean(production['requiresAdmin']),
      requiresMutationApproval: _boolean(
        production['requiresMutationApproval'],
      ),
      notes: _texts(governance['notes'], 40, 2000),
    );
  }
}

class QualityEvaluationsSnapshot {
  QualityEvaluationsSnapshot({
    required this.tenantId,
    required List<QualityRun> runs,
    required this.stats,
    required List<QualityJob> jobs,
    required List<QualityCase> cases,
  }) : runs = List.unmodifiable(runs),
       jobs = List.unmodifiable(jobs),
       cases = List.unmodifiable(cases);

  /// Bound to repository admission. The response has no root tenant field and
  /// projected jobs omit tenant IDs; the repository must fence their owner.
  final String tenantId;
  final List<QualityRun> runs;
  final QualityStats stats;
  final List<QualityJob> jobs;
  final List<QualityCase> cases;

  factory QualityEvaluationsSnapshot.parse(
    Object? value, {
    required String tenantId,
  }) {
    _text(tenantId, 120);
    final row = _object(value);
    final runs = _list(
      row['runs'],
      100,
      (item) => QualityRun.parse(item, tenantId: tenantId),
    );
    final jobs = _list(row['jobs'], 100, QualityJob.parse);
    final cases = _list(row['cases'], 200, QualityCase.parse);
    _unique(runs, (item) => item.id);
    _unique(jobs, (item) => item.id);
    _unique(cases, (item) => item.id);
    return QualityEvaluationsSnapshot(
      tenantId: tenantId,
      runs: runs,
      stats: QualityStats.parse(row['stats'], tenantId: tenantId),
      jobs: jobs,
      cases: cases,
    );
  }
}

class QualityDeployment {
  const QualityDeployment({
    required this.provider,
    required this.environment,
    this.url,
    this.commitSha,
    this.branch,
    this.region,
  });

  final String provider, environment;
  final String? url, commitSha, branch, region;

  factory QualityDeployment.parse(Object? value) {
    final row = _object(value);
    _require({'vercel', 'local'}.contains(row['provider']));
    return QualityDeployment(
      provider: row['provider'] as String,
      environment: _text(row['environment'], 160),
      // Display-only text; callers must never treat it as a navigation target.
      url: _optionalText(row['url'], 2000),
      commitSha: _optionalText(row['commitSha'], 200),
      branch: _optionalText(row['branch'], 300),
      region: _optionalText(row['region'], 160),
    );
  }
}

class QualityReleaseSummary {
  const QualityReleaseSummary({
    required this.total,
    required this.passed,
    required this.warnings,
    required this.failures,
  });

  final int total, passed, warnings, failures;

  factory QualityReleaseSummary.parse(Object? value) {
    final row = _object(value);
    final total = _count(row['total'], maximum: 100);
    final passed = _count(row['passed'], maximum: 100);
    final warnings = _count(row['warnings'], maximum: 100);
    final failures = _count(row['failures'], maximum: 100);
    _require(passed + warnings + failures == total);
    return QualityReleaseSummary(
      total: total,
      passed: passed,
      warnings: warnings,
      failures: failures,
    );
  }
}

class QualityReleaseGate {
  const QualityReleaseGate({
    required this.id,
    required this.name,
    required this.status,
    required this.summary,
  });

  final String id, name, summary;
  final QualityGateStatus status;

  factory QualityReleaseGate.parse(Object? value) {
    final row = _object(value);
    return QualityReleaseGate(
      id: _text(row['id'], 200),
      name: _text(row['name'], 300),
      status: _enum(
        row['status'],
        QualityGateStatus.values,
        (item) => item.wireValue,
      ),
      summary: _text(row['summary'], 4000, empty: true),
    );
  }
}

class QualityReleaseReport {
  QualityReleaseReport({
    required this.tenantId,
    required this.checkedAt,
    required this.deployment,
    required this.approved,
    required this.status,
    required this.summary,
    required List<String> reasons,
    required List<String> warnings,
    required List<QualityReleaseGate> gates,
    required List<String> recommendations,
  }) : reasons = List.unmodifiable(reasons),
       warnings = List.unmodifiable(warnings),
       gates = List.unmodifiable(gates),
       recommendations = List.unmodifiable(recommendations);

  final String tenantId;
  final DateTime checkedAt;
  final QualityDeployment deployment;

  /// The server's approval decision is preserved, never inferred from color,
  /// counts, or the successful completion of the GET request.
  final bool approved;
  final QualityReleaseStatus status;
  final QualityReleaseSummary summary;
  final List<String> reasons, warnings, recommendations;
  final List<QualityReleaseGate> gates;

  factory QualityReleaseReport.parse(
    Object? value, {
    required String tenantId,
  }) {
    _text(tenantId, 120);
    final row = _object(_object(value)['report']);
    final release = _object(row['releaseGate']);
    final summary = QualityReleaseSummary.parse(release['summary']);
    final gates = _list(row['gates'], 100, QualityReleaseGate.parse);
    _unique(gates, (item) => item.id);
    _require(
      gates.isNotEmpty &&
          gates.length == summary.total &&
          gates.where((item) => item.status == QualityGateStatus.pass).length ==
              summary.passed &&
          gates.where((item) => item.status == QualityGateStatus.warn).length ==
              summary.warnings &&
          gates.where((item) => item.status == QualityGateStatus.fail).length ==
              summary.failures,
    );
    final status = _enum(
      release['status'],
      QualityReleaseStatus.values,
      (item) => item.wireValue,
    );
    _require(switch (status) {
      QualityReleaseStatus.passed =>
        summary.failures == 0 && summary.warnings == 0,
      QualityReleaseStatus.warning =>
        summary.failures == 0 && summary.warnings > 0,
      QualityReleaseStatus.blocked => summary.failures > 0,
    });
    final approved = _boolean(release['approved']);
    _require(!approved || summary.failures == 0);
    return QualityReleaseReport(
      tenantId: _tenant(row['tenantId'], tenantId),
      checkedAt: _instant(row['checkedAt']),
      deployment: QualityDeployment.parse(row['deployment']),
      approved: approved,
      status: status,
      summary: summary,
      reasons: _texts(release['reasons'], 100, 4300),
      warnings: _texts(release['warnings'], 100, 4300),
      gates: gates,
      recommendations: _texts(row['recommendations'], 100, 4300),
    );
  }
}
