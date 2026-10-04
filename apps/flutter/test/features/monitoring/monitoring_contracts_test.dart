import 'package:asael/features/monitoring/monitoring_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'monitoring_test_support.dart';

Map<String, dynamic> _ordinarySlo(String metric) {
  final json = monitoringSloJson(insufficient: false);
  final policy = monitoringPolicyJson();
  final ratio = {'errorRate', 'availability'}.contains(metric);
  policy.addAll({
    'id': metric,
    'metric': metric,
    'unit': ratio
        ? 'ratio'
        : metric == 'latencyP95Ms'
        ? 'ms'
        : 'count',
    'comparator': metric == 'availability' ? 'less_than' : 'greater_than',
    'warningThreshold': metric == 'availability'
        ? .99
        : ratio
        ? .02
        : 10,
    'criticalThreshold': metric == 'availability'
        ? .95
        : ratio
        ? .05
        : 20,
  });
  json['stats'] = <String, dynamic>{'total': 120, 'sloEligibleEvents': 0};
  json['policies'] = [policy];
  json['evaluations'] = [
    monitoringEvaluationJson(insufficient: false)
      ..['policy'] = policy
      ..['value'] = metric == 'availability' ? 1 : 0,
  ];
  return json;
}

void main() {
  test('empty policies and insufficient samples never become an all-clear', () {
    final pending = MonitoringSloSnapshot.parse(
      monitoringSloJson(),
      tenantId: 'tenant-a',
    );
    expect(pending.serverHealthy, isTrue);
    expect(pending.assessment, 'Awaiting samples');
    expect(pending.evaluations.single.insufficient, isTrue);
    final empty = monitoringSloJson()
      ..['policies'] = []
      ..['evaluations'] = [];
    expect(
      MonitoringSloSnapshot.parse(empty, tenantId: 'tenant-a').assessment,
      'No enabled policies',
    );
    final measured = monitoringSloJson(insufficient: false);
    expect(
      MonitoringSloSnapshot.parse(measured, tenantId: 'tenant-a').assessment,
      'Within thresholds',
    );
    (measured['stats'] as Map)['total'] = 0;
    (measured['stats'] as Map)['sloEligibleEvents'] = 0;
    expect(
      MonitoringSloSnapshot.parse(measured, tenantId: 'tenant-a').assessment,
      'Within thresholds',
    );
  });
  for (final metric in [
    'errorRate',
    'availability',
    'latencyP95Ms',
    'routeFailures',
    'authFailures',
    'policyBlocks',
    'connectorFailures',
  ]) {
    test(
      '$metric uses eligible events, excluding synthetic-only default values',
      () {
        final json = _ordinarySlo(metric);
        final excluded = MonitoringSloSnapshot.parse(
          json,
          tenantId: 'tenant-a',
        );
        expect(excluded.eventCount, 120);
        expect(excluded.eligibleEventCount, 0);
        expect(excluded.isMeasured(excluded.evaluations.single), isFalse);
        expect(excluded.assessment, 'No eligible measurements');
        (json['stats'] as Map)['sloEligibleEvents'] = 1;
        final measured = MonitoringSloSnapshot.parse(
          json,
          tenantId: 'tenant-a',
        );
        expect(measured.isMeasured(measured.evaluations.single), isTrue);
        expect(measured.assessment, 'Within thresholds');
      },
    );
  }
  for (final metric in [
    'lcpP75Ms',
    'inpP75Ms',
    'clsP75',
    'runSuccessRate',
    'toolFailureRate',
    'agentFirstOutputP95Ms',
    'costPerRunUsd',
    'approvalLatencyP95Ms',
  ]) {
    test(
      '$metric retains its own sufficient samples even with no observability events',
      () {
        final json = monitoringSloJson(insufficient: false),
            policy = monitoringPolicyJson();
        final ratio = {'runSuccessRate', 'toolFailureRate'}.contains(metric);
        policy.addAll({
          'metric': metric,
          'unit': ratio
              ? 'ratio'
              : metric == 'clsP75'
              ? 'count'
              : metric == 'costPerRunUsd'
              ? 'usd'
              : 'ms',
          'warningThreshold': ratio ? .5 : 2500,
          'criticalThreshold': ratio ? .75 : 4000,
        });
        json['stats'] = <String, dynamic>{
          'total': 0,
          'sloEligibleEvents': 0,
          'webVitals': <String, dynamic>{
            'LCP': <String, dynamic>{'samples': 30},
            'INP': <String, dynamic>{'samples': 30},
            'CLS': <String, dynamic>{'samples': 30},
          },
          'agentFirstOutput': <String, dynamic>{'samples': 30},
        };
        json['agentQuality'] = <String, dynamic>{
          'runs': <String, dynamic>{'finished': 30},
          'tools': <String, dynamic>{'finished': 30},
          'approvals': <String, dynamic>{'decided': 30},
        };
        json['policies'] = [policy];
        json['evaluations'] = [
          monitoringEvaluationJson(insufficient: false)
            ..['policy'] = policy
            ..['value'] = 0,
        ];
        final snapshot = MonitoringSloSnapshot.parse(
          json,
          tenantId: 'tenant-a',
        );
        expect(snapshot.isMeasured(snapshot.evaluations.single), isTrue);
        expect(snapshot.sampleCounts[policy['id']], 30);
        expect(snapshot.assessment, 'Within thresholds');
      },
    );
  }
  test(
    'mixed measured and excluded-only policy families remain incomplete',
    () {
      final json = monitoringSloJson(insufficient: false),
          ordinary = _ordinarySlo('errorRate');
      (json['stats'] as Map)['sloEligibleEvents'] = 0;
      (json['policies'] as List).addAll(ordinary['policies'] as List);
      (json['evaluations'] as List).addAll(ordinary['evaluations'] as List);
      final snapshot = MonitoringSloSnapshot.parse(json, tenantId: 'tenant-a');
      expect(snapshot.measured, 1);
      expect(snapshot.unmeasured, 1);
      expect(snapshot.assessment, 'Incomplete measurements');
    },
  );
  for (final malformed in [
    'healthy',
    'missing evaluation',
    'policy mismatch',
    'unit mismatch',
    'comparator',
    'contradictory breach',
    'sample count',
    'missing insufficiency',
    'duplicate policy',
  ]) {
    test('SLO rejects $malformed evidence', () {
      final json = monitoringSloJson();
      final evaluation = (json['evaluations'] as List).single as Map;
      switch (malformed) {
        case 'healthy':
          json['healthy'] = false;
        case 'missing evaluation':
          json['evaluations'] = [];
        case 'policy mismatch':
          (evaluation['policy'] as Map)['warningThreshold'] = 2700;
        case 'unit mismatch':
          (evaluation['policy'] as Map)['unit'] = 'ratio';
        case 'comparator':
          (evaluation['policy'] as Map)['comparator'] = 'equals';
        case 'contradictory breach':
          evaluation['breached'] = true;
        case 'sample count':
          (evaluation['insufficientSamples'] as Map)['samples'] = 2;
        case 'missing insufficiency':
          evaluation.remove('insufficientSamples');
        case 'duplicate policy':
          (json['policies'] as List).add(monitoringPolicyJson());
      }
      expect(
        () => MonitoringSloSnapshot.parse(json, tenantId: 'tenant-a'),
        throwsFormatException,
      );
    });
  }
  test(
    'breached evaluation must match comparator, severity and breach list',
    () {
      final json = monitoringSloJson(insufficient: false);
      final evaluation =
          (json['evaluations'] as List).single as Map<String, dynamic>;
      evaluation.addAll({
        'value': 4600,
        'breached': true,
        'severity': 'critical',
        'threshold': 4000,
        'margin': 600,
      });
      json['healthy'] = false;
      json['breaches'] = [Map<String, dynamic>.from(evaluation)];
      expect(
        MonitoringSloSnapshot.parse(json, tenantId: 'tenant-a').assessment,
        '1 breached',
      );
      json['breaches'] = [];
      expect(
        () => MonitoringSloSnapshot.parse(json, tenantId: 'tenant-a'),
        throwsFormatException,
      );
    },
  );
  test(
    'private rows reject foreign tenants and unknown favorable outcomes',
    () {
      expect(
        () => MonitoringIncidents.parse(
          monitoringIncidentsJson(tenantId: 'other'),
          tenantId: 'tenant-a',
        ),
        throwsFormatException,
      );
      expect(
        () => MonitoringAlerts.parse(
          monitoringAlertsJson(tenantId: 'other'),
          tenantId: 'tenant-a',
        ),
        throwsFormatException,
      );
      expect(
        () => MonitoringTimeline.parse(
          monitoringTimelineJson(tenantId: 'other'),
          tenantId: 'tenant-a',
        ),
        throwsFormatException,
      );
      final json = monitoringAlertsJson();
      ((json['deliveries'] as List).single as Map)['status'] = 'successful';
      expect(
        () => MonitoringAlerts.parse(json, tenantId: 'tenant-a'),
        throwsFormatException,
      );
    },
  );
  test('statistics validate source sample bounds and status partitions', () {
    final alerts = monitoringAlertsJson();
    (alerts['stats'] as Map)['total'] = 500;
    expect(
      () => MonitoringAlerts.parse(alerts, tenantId: 'tenant-a'),
      throwsFormatException,
    );
    final incidents = monitoringIncidentsJson();
    (incidents['stats'] as Map)['active'] = 0;
    expect(
      () => MonitoringIncidents.parse(incidents, tenantId: 'tenant-a'),
      throwsFormatException,
    );
    final events = monitoringTimelineJson();
    (events['stats'] as Map)['total'] = 0;
    expect(
      () => MonitoringTimeline.parse(events, tenantId: 'tenant-a'),
      throwsFormatException,
    );
  });
  test('runtime routes match the writer bound of 512 characters', () {
    final json = monitoringTimelineJson();
    final row = (json['events'] as List).single as Map;
    row['route'] = '/${List.filled(511, 'a').join()}';
    expect(
      MonitoringTimeline.parse(
        json,
        tenantId: 'tenant-a',
      ).rows.single.route!.length,
      512,
    );
    row['route'] = '/${List.filled(512, 'a').join()}';
    expect(
      () => MonitoringTimeline.parse(json, tenantId: 'tenant-a'),
      throwsFormatException,
    );
  });
  test('health validates explicit status, booleans and timestamp', () {
    expect(
      MonitoringHealth.parse(monitoringHealthJson(status: 'unhealthy')).status,
      MonitoringHealthStatus.unhealthy,
    );
    final unknown = monitoringHealthJson(status: 'ok');
    expect(() => MonitoringHealth.parse(unknown), throwsFormatException);
    final malformed = monitoringHealthJson();
    (malformed['dependencies'] as Map)['databaseConfigured'] = 'true';
    expect(() => MonitoringHealth.parse(malformed), throwsFormatException);
    final undated = monitoringHealthJson()..['checkedAt'] = 'recent';
    expect(() => MonitoringHealth.parse(undated), throwsFormatException);
    for (final timestamp in [
      '2026-02-30T02:00:00.000Z',
      '2026-10-05T25:00:00.000Z',
      '2026-10-05T02:70:00.000Z',
    ]) {
      final normalized = monitoringHealthJson()..['checkedAt'] = timestamp;
      expect(() => MonitoringHealth.parse(normalized), throwsFormatException);
    }
  });
}
