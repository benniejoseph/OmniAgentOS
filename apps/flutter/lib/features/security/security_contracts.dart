/// Narrow projections of four existing Security GETs. Raw auth, native device,
/// audit metadata and duplicated context statistics are deliberately omitted.
library;

enum SecurityRole { viewer, operator, admin, system }

enum SecurityDecision { allow, deny }

enum SecurityStorage { postgres, file, ephemeral }

enum SecurityAssessment {
  passing('passing'),
  degraded('degraded'),
  notConfigured('not_configured');

  const SecurityAssessment(this.wire);
  final String wire;
}

enum SecurityTableCategory { root, child }

enum SecurityCheck { pass, fail }

enum SecurityRunStatus { running, completed, failed }

enum SecurityResultStatus { pass, fail, warn }

enum SecurityRetentionBackend {
  postgres('postgres'),
  boundedLocal('bounded_local');

  const SecurityRetentionBackend(this.wire);
  final String wire;
}

class SecurityIdentityMismatch implements Exception {
  const SecurityIdentityMismatch();
}

void _require(bool value) {
  if (!value) throw const FormatException('Security evidence is incomplete.');
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
int _count(Object? value, {int min = 0, int max = 2000}) {
  _require(value is int && value >= min && value <= max);
  return value as int;
}

bool _boolean(Object? value) {
  _require(value is bool);
  return value as bool;
}

T _enum<T extends Enum>(
  Object? value,
  List<T> values, {
  String Function(T)? wire,
}) {
  final entry = values
      .where((entry) => (wire?.call(entry) ?? entry.name) == value)
      .firstOrNull;
  _require(entry != null);
  return entry!;
}

DateTime _date(Object? value) {
  final text = _text(value, max: 40);
  final match = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$',
  ).firstMatch(text);
  final date = DateTime.tryParse(text);
  _require(match != null && date != null);
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

List<T> _rows<T>(
  Object? value,
  int max,
  T Function(Map<String, dynamic>) parse,
  String Function(T) id,
) {
  _require(value is List && value.length <= max);
  final rows = (value as List)
      .map((row) => parse(_object(row)))
      .toList(growable: false);
  _require(rows.map(id).toSet().length == rows.length);
  return List.unmodifiable(rows);
}

List<String> _strings(Object? value, {int max = 2000, int length = 240}) {
  _require(value is List && value.length <= max);
  final rows = (value as List)
      .map((item) => _text(item, max: length))
      .toList(growable: false);
  _require(rows.toSet().length == rows.length);
  return List.unmodifiable(rows);
}

void _sameNames(List<String> actual, Iterable<String> expected) {
  final names = expected.toSet();
  _require(actual.length == names.length && actual.every(names.contains));
}

class SecurityRule {
  const SecurityRule({
    required this.action,
    required this.description,
    required this.roles,
  });
  final String action, description;
  final List<SecurityRole> roles;
  factory SecurityRule.parse(Map<String, dynamic> row) {
    final roles = _strings(
      row['roles'],
      max: 4,
    ).map((role) => _enum(role, SecurityRole.values)).toList(growable: false);
    _require(roles.isNotEmpty);
    return SecurityRule(
      action: _text(row['action']),
      description: _text(row['description'], max: 2000),
      roles: List.unmodifiable(roles),
    );
  }
}

class SecurityAccessContext {
  const SecurityAccessContext({
    required this.tenantId,
    required this.actorId,
    required this.userId,
    required this.role,
    required this.rules,
  });
  final String tenantId, actorId, userId;
  final SecurityRole role;
  final List<SecurityRule> rules;
  factory SecurityAccessContext.parse(
    Map<String, dynamic> json, {
    required String tenantId,
    required String actorId,
    required String userId,
    required String role,
  }) {
    final context = _object(json['context']),
        auth = _object(_object(json['context'])['auth']);
    if (context['tenantId'] != tenantId ||
        context['actorId'] != actorId ||
        auth['userId'] != userId ||
        context['role'] != role ||
        context['source'] != 'mobile') {
      throw const SecurityIdentityMismatch();
    }
    final tenant = _text(context['tenantId']),
        actor = _text(context['actorId']),
        user = _text(auth['userId']);
    final admittedRole = _enum(context['role'], SecurityRole.values);
    return SecurityAccessContext(
      tenantId: tenant,
      actorId: actor,
      userId: user,
      role: admittedRole,
      rules: _rows(
        _object(json['policy'])['rbacRules'],
        500,
        SecurityRule.parse,
        (rule) => rule.action,
      ),
    );
  }
}

class SecurityAudit {
  const SecurityAudit({
    required this.id,
    required this.tenantId,
    required this.actorId,
    required this.actorRole,
    required this.action,
    required this.resourceType,
    required this.decision,
    required this.createdAt,
    this.resourceId,
    this.reason,
    this.riskLevel,
  });
  final String id, tenantId, actorId, action, resourceType;
  final String? resourceId, reason;
  final SecurityRole actorRole;
  final SecurityDecision decision;
  final DateTime createdAt;
  final int? riskLevel;
  factory SecurityAudit.parse(Map<String, dynamic> row, String tenantId) {
    _require(_text(row['tenantId']) == tenantId);
    return SecurityAudit(
      id: _text(row['id']),
      tenantId: tenantId,
      actorId: _text(row['actorId']),
      actorRole: _enum(row['actorRole'], SecurityRole.values),
      action: _text(row['action'], max: 500),
      resourceType: _text(row['resourceType']),
      resourceId: _optionalText(row['resourceId'], max: 1000),
      reason: _optionalText(row['reason'], max: 2000),
      riskLevel: row['riskLevel'] == null
          ? null
          : _count(row['riskLevel'], max: 3),
      decision: _enum(row['decision'], SecurityDecision.values),
      createdAt: _date(row['createdAt']),
    );
  }
}

class SecurityAudits {
  const SecurityAudits({
    required this.rows,
    required this.total,
    required this.allowed,
    required this.denied,
    required this.byRole,
  });
  final List<SecurityAudit> rows;
  final int total, allowed, denied;
  final Map<SecurityRole, int> byRole;
  factory SecurityAudits.parse(
    Map<String, dynamic> json, {
    required String tenantId,
  }) {
    final rows = _rows(
      json['records'],
      50,
      (row) => SecurityAudit.parse(row, tenantId),
      (row) => row.id,
    );
    final stats = _object(json['stats']),
        decisions = _object(stats['byDecision']),
        roles = _object(stats['byRole']);
    _require(
      decisions.keys.every(
        (key) => SecurityDecision.values.any((value) => value.name == key),
      ),
    );
    _require(
      roles.keys.every(
        (key) => SecurityRole.values.any((value) => value.name == key),
      ),
    );
    final total = _count(stats['total'], max: 200),
        allowed = _count(decisions['allow'] ?? 0, max: 200),
        denied = _count(decisions['deny'] ?? 0, max: 200);
    final byRole = {
      for (final role in SecurityRole.values)
        role: _count(roles[role.name] ?? 0, max: 200),
    };
    _require(
      allowed + denied == total &&
          byRole.values.fold<int>(0, (a, b) => a + b) == total,
    );
    // The list and the aggregate are separate server reads and may race.
    return SecurityAudits(
      rows: rows,
      total: total,
      allowed: allowed,
      denied: denied,
      byRole: Map.unmodifiable(byRole),
    );
  }
}

class SecurityTable {
  const SecurityTable({
    required this.name,
    required this.category,
    required this.exists,
    required this.tenantColumn,
    required this.rlsEnabled,
    required this.forceRls,
    required this.policyPresent,
    required this.status,
  });
  final String name;
  final SecurityTableCategory category;
  final bool exists, tenantColumn, rlsEnabled, forceRls, policyPresent;
  final SecurityCheck status;
  factory SecurityTable.parse(Map<String, dynamic> row) {
    final exists = _boolean(row['exists']),
        tenant = _boolean(row['tenantColumn']),
        rls = _boolean(row['rlsEnabled']),
        force = _boolean(row['forceRls']),
        policy = _boolean(row['policyPresent']);
    final status = _enum(row['status'], SecurityCheck.values);
    _require(
      (status == SecurityCheck.pass) ==
          (exists && tenant && rls && force && policy),
    );
    return SecurityTable(
      name: _text(row['tableName']),
      category: _enum(row['category'], SecurityTableCategory.values),
      exists: exists,
      tenantColumn: tenant,
      rlsEnabled: rls,
      forceRls: force,
      policyPresent: policy,
      status: status,
    );
  }
}

class SecurityIsolationEvaluation {
  const SecurityIsolationEvaluation({
    required this.runId,
    required this.runStatus,
    required this.resultStatus,
    required this.score,
    required this.createdAt,
    this.completedAt,
  });
  final String runId;
  final SecurityRunStatus runStatus;
  final SecurityResultStatus resultStatus;
  final double score;
  final DateTime createdAt;
  final DateTime? completedAt;
  factory SecurityIsolationEvaluation.parse(Map<String, dynamic> row) {
    final score = row['score'];
    _require(
      score is num && score.isFinite && score >= 0 && score <= 1000000000,
    );
    final created = _date(row['createdAt']),
        completed = row['completedAt'] == null
            ? null
            : _date(row['completedAt']);
    _require(completed == null || !completed.isBefore(created));
    return SecurityIsolationEvaluation(
      runId: _text(row['runId']),
      runStatus: _enum(row['runStatus'], SecurityRunStatus.values),
      resultStatus: _enum(row['resultStatus'], SecurityResultStatus.values),
      score: (score as num).toDouble(),
      createdAt: created,
      completedAt: completed,
    );
  }
}

class SecurityIsolation {
  const SecurityIsolation({
    required this.tenantId,
    required this.checkedAt,
    required this.backend,
    required this.databaseConfigured,
    required this.assessment,
    required this.tables,
    required this.expected,
    required this.protected,
    required this.failing,
    required this.unclassified,
    required this.issues,
    required this.recommendations,
    this.latestEval,
  });
  final String tenantId;
  final DateTime checkedAt;
  final SecurityStorage backend;
  final bool databaseConfigured;
  final SecurityAssessment assessment;
  final List<SecurityTable> tables;
  final int expected, protected, failing;
  final List<String> unclassified, recommendations;
  final Map<String, List<String>> issues;
  final SecurityIsolationEvaluation? latestEval;
  int get expectedChildren => tables
      .where((table) => table.category == SecurityTableCategory.child)
      .length;
  int get protectedChildren => tables
      .where(
        (table) =>
            table.category == SecurityTableCategory.child &&
            table.status == SecurityCheck.pass,
      )
      .length;
  factory SecurityIsolation.parse(
    Map<String, dynamic> json, {
    required String tenantId,
  }) {
    final report = _object(json['report']),
        summary = _object(report['summary']);
    _require(_text(report['tenantId']) == tenantId);
    final tables = _rows(
      report['tables'],
      2000,
      SecurityTable.parse,
      (table) => table.name,
    );
    final configured = _boolean(report['databaseConfigured']),
        backend = _enum(report['storageBackend'], SecurityStorage.values),
        status = _enum(
          report['status'],
          SecurityAssessment.values,
          wire: (entry) => entry.wire,
        );
    final expected = _count(summary['expectedTables'], min: 1),
        protected = _count(summary['protectedTables']),
        failing = _count(summary['failingTables']),
        children = _count(summary['childTables']);
    final unclassified = _strings(summary['unclassifiedTables']);
    final issues = {
      for (final key in [
        'missingTables',
        'missingTenantColumns',
        'rlsDisabled',
        'forceRlsDisabled',
        'missingPolicies',
      ])
        key: _strings(summary[key]),
    };
    _sameNames(
      issues['missingTables']!,
      tables.where((table) => !table.exists).map((table) => table.name),
    );
    _sameNames(
      issues['missingTenantColumns']!,
      tables.where((table) => !table.tenantColumn).map((table) => table.name),
    );
    _sameNames(
      issues['rlsDisabled']!,
      tables.where((table) => !table.rlsEnabled).map((table) => table.name),
    );
    _sameNames(
      issues['forceRlsDisabled']!,
      tables.where((table) => !table.forceRls).map((table) => table.name),
    );
    _sameNames(
      issues['missingPolicies']!,
      tables.where((table) => !table.policyPresent).map((table) => table.name),
    );
    _require(
      expected == tables.length &&
          protected ==
              tables
                  .where((table) => table.status == SecurityCheck.pass)
                  .length &&
          failing == expected - protected,
    );
    _require(
      unclassified.every((name) => !tables.any((table) => table.name == name)),
    );
    _require(configured == (backend == SecurityStorage.postgres));
    _require(
      children ==
          tables
              .where(
                (table) =>
                    table.category == SecurityTableCategory.child &&
                    (!configured || table.status == SecurityCheck.pass),
              )
              .length,
    );
    if (!configured) {
      _require(
        status == SecurityAssessment.notConfigured &&
            unclassified.isEmpty &&
            tables.every(
              (table) =>
                  !table.exists &&
                  !table.tenantColumn &&
                  !table.rlsEnabled &&
                  !table.forceRls &&
                  !table.policyPresent,
            ),
      );
    } else {
      _require(
        status ==
            (failing == 0 && unclassified.isEmpty
                ? SecurityAssessment.passing
                : SecurityAssessment.degraded),
      );
    }
    return SecurityIsolation(
      tenantId: tenantId,
      checkedAt: _date(report['checkedAt']),
      backend: backend,
      databaseConfigured: configured,
      assessment: status,
      tables: tables,
      expected: expected,
      protected: protected,
      failing: failing,
      unclassified: unclassified,
      issues: Map.unmodifiable(issues),
      recommendations: _strings(
        report['recommendations'],
        max: 100,
        length: 4000,
      ),
      latestEval: report['latestEval'] == null
          ? null
          : SecurityIsolationEvaluation.parse(_object(report['latestEval'])),
    );
  }
}

enum SecurityRetentionWindow {
  pendingApprovalDays('Pending tool approvals', 'Approvals and access'),
  pendingAccessRequestDays('Pending access requests', 'Approvals and access'),
  reviewedAccessRequestDays('Reviewed access requests', 'Approvals and access'),
  episodeMemoryDays('Episode memory', 'Memory and content'),
  consolidatedMemoryDays('Consolidated memory', 'Memory and content'),
  retrievalTraceDays('Retrieval traces', 'Memory and content'),
  runContentDays('Run content', 'Memory and content'),
  toolPayloadDays('Tool payloads', 'Memory and content'),
  workflowDays('Workflows', 'Execution and history'),
  triggerEventDays('Trigger events', 'Execution and history'),
  operationJobDays('Operation jobs', 'Execution and history'),
  evaluationHistoryDays('Evaluation history', 'Execution and history'),
  graphBuildHistoryDays('Graph build history', 'Execution and history'),
  aiUsageDays('AI usage', 'Security and telemetry'),
  domainEventDays('Domain events', 'Security and telemetry'),
  observabilityDays('Observability events', 'Security and telemetry'),
  healthHistoryDays('Health history', 'Security and telemetry'),
  securityAuditDays('Security audit records', 'Security and telemetry');

  const SecurityRetentionWindow(this.label, this.group);
  final String label, group;
}

class SecurityRetention {
  const SecurityRetention({
    required this.days,
    required this.backend,
    required this.automaticSweep,
  });
  final Map<SecurityRetentionWindow, int> days;
  final SecurityRetentionBackend backend;
  final bool automaticSweep;
  factory SecurityRetention.parse(Map<String, dynamic> json) {
    final policy = _object(json['policy']),
        backend = _enum(
          json['backend'],
          SecurityRetentionBackend.values,
          wire: (entry) => entry.wire,
        ),
        automatic = _boolean(json['automaticSweep']);
    _require(automatic == (backend == SecurityRetentionBackend.postgres));
    return SecurityRetention(
      days: Map.unmodifiable({
        for (final window in SecurityRetentionWindow.values)
          window: _count(policy[window.name], min: 1, max: 3650),
      }),
      backend: backend,
      automaticSweep: automatic,
    );
  }
}
