/// Bounded projections of existing Monitoring GET responses. Raw operational
/// payloads, provider responses, metadata and queue leases are never retained.
library;

enum MonitoringHealthStatus { healthy, degraded, unhealthy }

enum MonitoringSeverity { info, warning, critical }

enum MonitoringIncidentStatus { open, acknowledged, resolved }

enum MonitoringAlertStatus { queued, running, delivered, failed, skipped }

enum MonitoringChannel { dashboard, ops, webhook, email, slack }

enum MonitoringEventLevel { info, warn, error }

enum MonitoringEventCategory {
  api,
  workflow,
  alert,
  diagnostics,
  evaluation,
  connector,
  security,
  system,
}

enum MonitoringUnit { ratio, ms, count, usd }

enum MonitoringComparator {
  greaterThan('greater_than', '>'),
  greaterThanOrEqual('greater_than_or_equal', '≥'),
  lessThan('less_than', '<'),
  lessThanOrEqual('less_than_or_equal', '≤');

  const MonitoringComparator(this.wire, this.symbol);
  final String wire, symbol;
  bool breaches(double value, double threshold) => switch (this) {
    greaterThan => value > threshold,
    greaterThanOrEqual => value >= threshold,
    lessThan => value < threshold,
    lessThanOrEqual => value <= threshold,
  };
}

void _require(bool valid) {
  if (!valid) throw const FormatException('Monitoring evidence is incomplete.');
}

Map<String, dynamic> _object(Object? value) {
  _require(value is Map<String, dynamic>);
  return value as Map<String, dynamic>;
}

String _text(Object? value, {int max = 240, bool empty = false}) {
  _require(
    value is String &&
        value.length <= max &&
        (empty || value.trim().isNotEmpty),
  );
  return value as String;
}

String? _optionalText(Object? value, {int max = 240}) =>
    value == null ? null : _text(value, max: max, empty: true);
int _count(Object? value, {int max = 1000000000, int min = 0}) {
  _require(value is int && value >= min && value <= max);
  return value as int;
}

double _number(Object? value, {double max = 1e15}) {
  _require(value is num && value.isFinite && value >= 0 && value <= max);
  return (value as num).toDouble();
}

bool _boolean(Object? value) {
  _require(value is bool);
  return value as bool;
}

DateTime _date(Object? value) {
  final text = _text(value, max: 40);
  final match = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$',
  ).firstMatch(text);
  final date = DateTime.tryParse(text);
  _require(match != null && date != null);
  // DateTime.tryParse normalizes impossible dates; evidence must not.
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

DateTime? _optionalDate(Object? value) => value == null ? null : _date(value);
T _enum<T extends Enum>(Object? value, List<T> values) {
  final match = values.where((entry) => entry.name == value).firstOrNull;
  _require(match != null);
  return match!;
}

List<T> _rows<T>(
  Object? value,
  int max,
  T Function(Map<String, dynamic>) parse,
  String Function(T) id,
) {
  _require(value is List && value.length <= max);
  final result = (value as List)
      .map((item) => parse(_object(item)))
      .toList(growable: false);
  _require(result.map(id).toSet().length == result.length);
  return List.unmodifiable(result);
}

void _tenant(
  Map<String, dynamic> value,
  String tenantId, {
  bool optional = false,
}) {
  if (optional && value['tenantId'] == null) return;
  _require(_text(value['tenantId'], max: 200) == tenantId);
}

class MonitoringHealth {
  const MonitoringHealth({
    required this.status,
    required this.checkedAt,
    required this.databaseConfigured,
    required this.openAiConfigured,
    required this.cronSecretConfigured,
    this.revision,
  });
  final MonitoringHealthStatus status;
  final DateTime checkedAt;
  final bool databaseConfigured, openAiConfigured, cronSecretConfigured;
  final String? revision;
  factory MonitoringHealth.parse(Map<String, dynamic> json) {
    final dependencies = _object(json['dependencies']);
    return MonitoringHealth(
      status: _enum(json['status'], MonitoringHealthStatus.values),
      checkedAt: _date(json['checkedAt']),
      databaseConfigured: _boolean(dependencies['databaseConfigured']),
      openAiConfigured: _boolean(dependencies['openAiConfigured']),
      cronSecretConfigured: _boolean(dependencies['cronSecretConfigured']),
      revision: _optionalText(json['revision'], max: 100),
    );
  }
}

class MonitoringPolicy {
  const MonitoringPolicy({
    required this.id,
    required this.name,
    required this.description,
    required this.metric,
    required this.unit,
    required this.comparator,
    required this.warningThreshold,
    required this.criticalThreshold,
    required this.warningSeverity,
    required this.criticalSeverity,
    required this.component,
    required this.minimumSamples,
  });
  final String id, name, description, metric, component;
  final MonitoringUnit unit;
  final MonitoringComparator comparator;
  final double warningThreshold, criticalThreshold;
  final MonitoringSeverity warningSeverity, criticalSeverity;
  final int minimumSamples;
  static const _units = {
    'errorRate': MonitoringUnit.ratio,
    'availability': MonitoringUnit.ratio,
    'latencyP95Ms': MonitoringUnit.ms,
    'routeFailures': MonitoringUnit.count,
    'authFailures': MonitoringUnit.count,
    'policyBlocks': MonitoringUnit.count,
    'connectorFailures': MonitoringUnit.count,
    'lcpP75Ms': MonitoringUnit.ms,
    'inpP75Ms': MonitoringUnit.ms,
    'clsP75': MonitoringUnit.count,
    'runSuccessRate': MonitoringUnit.ratio,
    'toolFailureRate': MonitoringUnit.ratio,
    'agentFirstOutputP95Ms': MonitoringUnit.ms,
    'costPerRunUsd': MonitoringUnit.usd,
    'approvalLatencyP95Ms': MonitoringUnit.ms,
  };
  bool get sampled => {
    'lcpP75Ms',
    'inpP75Ms',
    'clsP75',
    'runSuccessRate',
    'toolFailureRate',
    'agentFirstOutputP95Ms',
    'costPerRunUsd',
    'approvalLatencyP95Ms',
  }.contains(metric);
  Object get signature => (
    id,
    name,
    description,
    metric,
    unit,
    comparator,
    warningThreshold,
    criticalThreshold,
    warningSeverity,
    criticalSeverity,
    component,
    minimumSamples,
  );
  factory MonitoringPolicy.parse(Map<String, dynamic> json, String tenantId) {
    _tenant(json, tenantId, optional: true);
    _require(_boolean(json['enabled']));
    final metric = _text(json['metric'], max: 80);
    final unit = _enum(json['unit'], MonitoringUnit.values);
    _require(_units[metric] == unit);
    final comparator = MonitoringComparator.values
        .where((item) => item.wire == json['comparator'])
        .firstOrNull;
    _require(comparator != null);
    final warning = _number(
      json['warningThreshold'],
      max: unit == MonitoringUnit.ratio ? 1 : 1e15,
    );
    final critical = _number(
      json['criticalThreshold'],
      max: unit == MonitoringUnit.ratio ? 1 : 1e15,
    );
    final greater =
        comparator == MonitoringComparator.greaterThan ||
        comparator == MonitoringComparator.greaterThanOrEqual;
    _require(greater ? critical >= warning : critical <= warning);
    final metadata = _object(json['metadata']);
    final rawMinimum = metadata['minimumSamples'];
    // Matches the server's default when a historical policy has no valid minimum.
    final minimum =
        rawMinimum is int && rawMinimum >= 1 && rawMinimum <= 9007199254740991
        ? rawMinimum
        : 20;
    return MonitoringPolicy(
      id: _text(json['id'], max: 200),
      name: _text(json['name']),
      description: _text(json['description'], max: 2000, empty: true),
      metric: metric,
      unit: unit,
      comparator: comparator!,
      warningThreshold: warning,
      criticalThreshold: critical,
      warningSeverity: _enum(
        json['warningSeverity'],
        MonitoringSeverity.values,
      ),
      criticalSeverity: _enum(
        json['criticalSeverity'],
        MonitoringSeverity.values,
      ),
      component: _text(json['componentId'], max: 200),
      minimumSamples: minimum,
    );
  }
  String format(double value) => switch (unit) {
    MonitoringUnit.ratio => '${(value * 100).toStringAsFixed(2)}%',
    MonitoringUnit.ms => '${value.toStringAsFixed(value < 10 ? 2 : 0)} ms',
    MonitoringUnit.usd => '\$${value.toStringAsFixed(4)}',
    MonitoringUnit.count =>
      value == value.roundToDouble()
          ? value.toStringAsFixed(0)
          : value.toStringAsFixed(3),
  };
}

class MonitoringSloEvaluation {
  const MonitoringSloEvaluation({
    required this.policy,
    required this.value,
    required this.breached,
    required this.message,
    this.severity,
    this.threshold,
    this.samples,
    this.minimumSamples,
  });
  final MonitoringPolicy policy;
  final double value;
  final bool breached;
  final String message;
  final MonitoringSeverity? severity;
  final double? threshold;
  final int? samples, minimumSamples;
  bool get insufficient => samples != null;
  Object get signature => (
    policy.signature,
    value,
    breached,
    message,
    severity,
    threshold,
    samples,
    minimumSamples,
  );
  factory MonitoringSloEvaluation.parse(
    Map<String, dynamic> json,
    String tenantId,
  ) {
    final policy = MonitoringPolicy.parse(_object(json['policy']), tenantId);
    final value = _number(
      json['value'],
      max: policy.unit == MonitoringUnit.ratio ? 1 : 1e15,
    );
    final breached = _boolean(json['breached']);
    final severity = json['severity'] == null
        ? null
        : _enum(json['severity'], MonitoringSeverity.values);
    final threshold = json['threshold'] == null
        ? null
        : _number(json['threshold']);
    final margin = _number(json['margin']);
    int? samples, minimumSamples;
    if (json['insufficientSamples'] != null) {
      final insufficient = _object(json['insufficientSamples']);
      samples = _count(insufficient['samples']);
      minimumSamples = _count(
        insufficient['minimumSamples'],
        min: 1,
        max: 9007199254740991,
      );
      _require(
        policy.sampled &&
            samples < minimumSamples &&
            minimumSamples == policy.minimumSamples &&
            !breached &&
            severity == null &&
            threshold == null &&
            margin == 0,
      );
    } else {
      final critical = policy.comparator.breaches(
        value,
        policy.criticalThreshold,
      );
      final warning = policy.comparator.breaches(
        value,
        policy.warningThreshold,
      );
      final expectedSeverity = critical
          ? policy.criticalSeverity
          : warning
          ? policy.warningSeverity
          : null;
      final expectedThreshold = critical
          ? policy.criticalThreshold
          : warning
          ? policy.warningThreshold
          : null;
      _require(
        breached == (expectedSeverity != null) &&
            severity == expectedSeverity &&
            threshold == expectedThreshold,
      );
      _require(
        expectedThreshold == null
            ? margin == 0
            : (margin - (value - expectedThreshold).abs()).abs() <= .00011,
      );
    }
    return MonitoringSloEvaluation(
      policy: policy,
      value: value,
      breached: breached,
      message: _text(json['message'], max: 2000),
      severity: severity,
      threshold: threshold,
      samples: samples,
      minimumSamples: minimumSamples,
    );
  }
}

class MonitoringSloSnapshot {
  const MonitoringSloSnapshot({
    required this.checkedAt,
    required this.serverHealthy,
    required this.eventCount,
    required this.eligibleEventCount,
    required this.sampleCounts,
    required this.evaluations,
  });
  final DateTime checkedAt;
  final bool serverHealthy;
  final int eventCount, eligibleEventCount;
  final Map<String, int> sampleCounts;
  final List<MonitoringSloEvaluation> evaluations;
  bool isMeasured(MonitoringSloEvaluation row) => row.policy.sampled
      ? !row.insufficient &&
            (sampleCounts[row.policy.id] ?? 0) >= row.policy.minimumSamples
      : eligibleEventCount > 0;
  int get measured => evaluations.where(isMeasured).length;
  int get unmeasured =>
      evaluations.where((row) => !row.insufficient && !isMeasured(row)).length;
  int get breaches =>
      evaluations.where((row) => isMeasured(row) && row.breached).length;
  int get insufficient => evaluations.where((row) => row.insufficient).length;
  String get assessment => breaches > 0
      ? '$breaches breached'
      : evaluations.isEmpty
      ? 'No enabled policies'
      : insufficient > 0
      ? 'Awaiting samples'
      : unmeasured > 0
      ? measured == 0
            ? 'No eligible measurements'
            : 'Incomplete measurements'
      : 'Within thresholds';
  factory MonitoringSloSnapshot.parse(
    Map<String, dynamic> json, {
    required String tenantId,
  }) {
    final policies = _rows(
      json['policies'],
      250,
      (row) => MonitoringPolicy.parse(row, tenantId),
      (row) => row.id,
    );
    final evaluations = _rows(
      json['evaluations'],
      250,
      (row) => MonitoringSloEvaluation.parse(row, tenantId),
      (row) => row.policy.id,
    );
    final breaches = _rows(
      json['breaches'],
      250,
      (row) => MonitoringSloEvaluation.parse(row, tenantId),
      (row) => row.policy.id,
    );
    final byId = {for (final policy in policies) policy.id: policy};
    _require(
      policies.length == evaluations.length &&
          evaluations.every(
            (row) => row.policy.signature == byId[row.policy.id]?.signature,
          ),
    );
    final stats = _object(json['stats']);
    final eventCount = _count(stats['total']),
        eligibleEventCount = _count(stats['sloEligibleEvents']);
    _require(eligibleEventCount <= eventCount);
    final sampleCounts = <String, int>{};
    for (final row in evaluations.where((row) => row.policy.sampled)) {
      final metric = row.policy.metric;
      final int samples;
      if ({'lcpP75Ms', 'inpP75Ms', 'clsP75'}.contains(metric)) {
        final name = metric == 'lcpP75Ms'
            ? 'LCP'
            : metric == 'inpP75Ms'
            ? 'INP'
            : 'CLS';
        samples = _count(_object(_object(stats['webVitals'])[name])['samples']);
      } else if (metric == 'agentFirstOutputP95Ms') {
        samples = _count(_object(stats['agentFirstOutput'])['samples']);
      } else {
        final quality = _object(json['agentQuality']);
        final group = metric == 'toolFailureRate'
            ? 'tools'
            : metric == 'approvalLatencyP95Ms'
            ? 'approvals'
            : 'runs';
        samples = _count(
          _object(quality[group])[group == 'approvals'
              ? 'decided'
              : 'finished'],
        );
      }
      _require(row.insufficient == (samples < row.policy.minimumSamples));
      if (row.insufficient) _require(row.samples == samples);
      sampleCounts[row.policy.id] = samples;
    }
    final expected = {
      for (final row in evaluations.where((row) => row.breached))
        row.policy.id: row.signature,
    };
    _require(
      breaches.length == expected.length &&
          breaches.every(
            (row) => row.breached && row.signature == expected[row.policy.id],
          ),
    );
    final healthy = _boolean(json['healthy']);
    _require(healthy == breaches.isEmpty);
    return MonitoringSloSnapshot(
      checkedAt: _date(json['checkedAt']),
      serverHealthy: healthy,
      eventCount: eventCount,
      eligibleEventCount: eligibleEventCount,
      sampleCounts: Map.unmodifiable(sampleCounts),
      evaluations: evaluations,
    );
  }
}

class MonitoringIncident {
  const MonitoringIncident({
    required this.id,
    required this.title,
    required this.message,
    required this.component,
    required this.severity,
    required this.status,
    required this.occurrences,
    required this.firstSeenAt,
    required this.lastSeenAt,
    this.acknowledgedAt,
  });
  final String id, title, message, component;
  final MonitoringSeverity severity;
  final MonitoringIncidentStatus status;
  final int occurrences;
  final DateTime firstSeenAt, lastSeenAt;
  final DateTime? acknowledgedAt;
  factory MonitoringIncident.parse(Map<String, dynamic> json, String tenantId) {
    _tenant(json, tenantId);
    final status = _enum(json['status'], MonitoringIncidentStatus.values);
    _require(status != MonitoringIncidentStatus.resolved);
    final first = _date(json['firstSeenAt']), last = _date(json['lastSeenAt']);
    _require(!last.isBefore(first));
    return MonitoringIncident(
      id: _text(json['id'], max: 200),
      title: _text(json['title'], max: 500),
      message: _text(json['message'], max: 4000, empty: true),
      component: _text(json['componentId'], max: 200),
      severity: _enum(json['severity'], MonitoringSeverity.values),
      status: status,
      occurrences: _count(json['occurrenceCount'], min: 1),
      firstSeenAt: first,
      lastSeenAt: last,
      acknowledgedAt: _optionalDate(json['acknowledgedAt']),
    );
  }
}

class MonitoringIncidents {
  const MonitoringIncidents({
    required this.rows,
    required this.total,
    required this.active,
    required this.critical,
  });
  final List<MonitoringIncident> rows;
  final int total, active, critical;
  factory MonitoringIncidents.parse(
    Map<String, dynamic> json, {
    required String tenantId,
  }) {
    final rows = _rows(
      json['incidents'],
      25,
      (row) => MonitoringIncident.parse(row, tenantId),
      (row) => row.id,
    );
    final stats = _object(json['stats']);
    final total = _count(stats['total'], max: 500),
        active = _count(stats['active'], max: 500),
        critical = _count(stats['criticalOpen'], max: 500);
    final open = _count(stats['open'], max: 500),
        acknowledged = _count(stats['acknowledged'], max: 500),
        resolved = _count(stats['resolved'], max: 500),
        warning = _count(stats['warningOpen'], max: 500);
    _require(
      total == open + acknowledged + resolved &&
          active == open + acknowledged &&
          critical + warning <= active,
    );
    return MonitoringIncidents(
      rows: rows,
      total: total,
      active: active,
      critical: critical,
    );
  }
}

class MonitoringAlert {
  const MonitoringAlert({
    required this.id,
    required this.incidentId,
    required this.targetId,
    required this.channel,
    required this.status,
    required this.severity,
    required this.attempt,
    required this.maxAttempts,
    required this.runAt,
    required this.updatedAt,
    this.deliveredAt,
  });
  final String id, incidentId, targetId;
  final MonitoringChannel channel;
  final MonitoringAlertStatus status;
  final MonitoringSeverity severity;
  final int attempt, maxAttempts;
  final DateTime runAt, updatedAt;
  final DateTime? deliveredAt;
  factory MonitoringAlert.parse(Map<String, dynamic> json, String tenantId) {
    _tenant(json, tenantId);
    final attempt = _count(json['attempt'], max: 1000000),
        maxAttempts = _count(json['maxAttempts'], min: 1, max: 1000000);
    return MonitoringAlert(
      id: _text(json['id'], max: 200),
      incidentId: _text(json['incidentId'], max: 200),
      targetId: _text(json['targetId'], max: 200),
      channel: _enum(json['channel'], MonitoringChannel.values),
      status: _enum(json['status'], MonitoringAlertStatus.values),
      severity: _enum(json['severity'], MonitoringSeverity.values),
      attempt: attempt,
      maxAttempts: maxAttempts,
      runAt: _date(json['runAt']),
      updatedAt: _date(json['updatedAt']),
      deliveredAt: _optionalDate(json['deliveredAt']),
    );
  }
}

class MonitoringAlerts {
  const MonitoringAlerts({
    required this.rows,
    required this.total,
    required this.queued,
    required this.running,
    required this.delivered,
    required this.failed,
    required this.skipped,
  });
  final List<MonitoringAlert> rows;
  final int total, queued, running, delivered, failed, skipped;
  factory MonitoringAlerts.parse(
    Map<String, dynamic> json, {
    required String tenantId,
  }) {
    final rows = _rows(
      json['deliveries'],
      50,
      (row) => MonitoringAlert.parse(row, tenantId),
      (row) => row.id,
    );
    final stats = _object(json['stats']);
    final total = _count(stats['total'], max: 200),
        queued = _count(stats['queued'], max: 200),
        running = _count(stats['running'], max: 200),
        delivered = _count(stats['delivered'], max: 200),
        failed = _count(stats['failed'], max: 200),
        skipped = _count(stats['skipped'], max: 200);
    _require(total == queued + running + delivered + failed + skipped);
    return MonitoringAlerts(
      rows: rows,
      total: total,
      queued: queued,
      running: running,
      delivered: delivered,
      failed: failed,
      skipped: skipped,
    );
  }
}

class MonitoringEvent {
  const MonitoringEvent({
    required this.id,
    required this.action,
    required this.message,
    required this.category,
    required this.level,
    required this.createdAt,
    required this.correlationId,
    this.route,
    this.method,
    this.statusCode,
    this.durationMs,
  });
  final String id, action, message, correlationId;
  final String? route, method;
  final MonitoringEventCategory category;
  final MonitoringEventLevel level;
  final DateTime createdAt;
  final int? statusCode;
  final double? durationMs;
  factory MonitoringEvent.parse(Map<String, dynamic> json, String tenantId) {
    _tenant(json, tenantId, optional: true);
    return MonitoringEvent(
      id: _text(json['id'], max: 200),
      action: _text(json['action'], max: 240),
      message: _text(json['message'], max: 4000, empty: true),
      correlationId: _text(json['correlationId'], max: 240),
      category: _enum(json['category'], MonitoringEventCategory.values),
      level: _enum(json['level'], MonitoringEventLevel.values),
      createdAt: _date(json['createdAt']),
      route: _optionalText(json['route'], max: 512),
      method: _optionalText(json['method'], max: 16),
      statusCode: json['statusCode'] == null
          ? null
          : _count(json['statusCode'], min: 100, max: 599),
      durationMs: json['durationMs'] == null
          ? null
          : _number(json['durationMs']),
    );
  }
}

class MonitoringTimeline {
  const MonitoringTimeline({
    required this.rows,
    required this.total,
    required this.errors,
    required this.warnings,
    required this.p95Ms,
  });
  final List<MonitoringEvent> rows;
  final int total, errors, warnings;
  final double p95Ms;
  factory MonitoringTimeline.parse(
    Map<String, dynamic> json, {
    required String tenantId,
  }) {
    final rows = _rows(
      json['events'],
      50,
      (row) => MonitoringEvent.parse(row, tenantId),
      (row) => row.id,
    );
    final stats = _object(json['stats']), levels = _object(stats['byLevel']);
    _require(
      levels.keys.every((key) => {'info', 'warn', 'error'}.contains(key)),
    );
    final total = _count(stats['total']),
        errors = _count(levels['error'] ?? 0),
        warnings = _count(levels['warn'] ?? 0),
        info = _count(levels['info'] ?? 0);
    _require(total == errors + warnings + info);
    return MonitoringTimeline(
      rows: rows,
      total: total,
      errors: errors,
      warnings: warnings,
      p95Ms: _number(stats['p95DurationMs']),
    );
  }
}
