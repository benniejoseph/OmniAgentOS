import 'dart:convert';

// Decoding gives every nested object genuine dynamic JSON value slots. Negative
// cases must reach the decoder rather than fail in an inferred Dart map setter.
Map<String, dynamic> _json(Map<String, dynamic> value) =>
    jsonDecode(jsonEncode(value)) as Map<String, dynamic>;

/// Synthetic, tenant-scoped responses shaped like the existing GET contracts.
Map<String, dynamic> qualityRunJson({String tenantId = 'tenant-a'}) => _json({
  'id': 'eval-run-1',
  'tenantId': tenantId,
  'suite': 'Core operations',
  'status': 'completed',
  'summary': {
    'total': 3,
    'passed': 1,
    'failed': 1,
    'warnings': 1,
    'averageLatencyMs': 120.5,
    'estimatedCostUsd': 0.002,
  },
  'startedAt': '2026-10-04T20:00:00.000Z',
  'completedAt': '2026-10-04T20:01:00.000Z',
  'createdAt': '2026-10-04T20:00:00.000Z',
  'updatedAt': '2026-10-04T20:01:00.000Z',
});

Map<String, dynamic> qualityJobJson() => _json({
  'id': 'evaluation-job-1',
  'type': 'evaluation.run',
  'status': 'failed',
  'quarantined': true,
  'progress': {'stage': 'untrusted private progress'},
  'result': {'evalRunId': 'eval-run-1', 'privateResult': 'not retained'},
  'priority': 100,
  'attempt': 3,
  'maxAttempts': 3,
  'runAt': '2026-10-04T20:00:00.000Z',
  'lastError': 'Worker delivery expired.',
  'createdAt': '2026-10-04T20:00:00.000Z',
  'updatedAt': '2026-10-04T20:01:00.000Z',
});

Map<String, dynamic> qualityCaseJson() => _json({
  'id': 'system.health',
  'name': 'System health',
  'description': 'Checks basic service readiness.',
  'type': 'system',
  'input': {'privateInput': 'not retained'},
  'expected': {'privateExpectation': 'not retained'},
  'governance': {
    'safetyMode': 'synthetic',
    'riskLevel': 1,
    'writesToDatabase': true,
    'cleanup': 'self_cleaning',
    'production': {
      'allowedByDefault': true,
      'requiresAdmin': false,
      'requiresMutationApproval': false,
    },
    'notes': ['Temporary fixtures are removed after the case.'],
  },
});

Map<String, dynamic> qualityEvaluationsJson({String tenantId = 'tenant-a'}) =>
    _json({
      'runs': [qualityRunJson(tenantId: tenantId)],
      'stats': {
        'total': 1,
        'byStatus': {'completed': 1},
        'latest': qualityRunJson(tenantId: tenantId),
        'latestPassRate': 1 / 3,
        'averageLatencyMs': 120.5,
        'estimatedCostUsd': 0.002,
      },
      'jobs': [qualityJobJson()],
      'cases': [qualityCaseJson()],
      'governance': {'privateUnusedAggregate': 'not retained'},
      'defaults': {'maxSafetyMode': 'synthetic'},
    });

Map<String, dynamic> qualityReleaseJson({String tenantId = 'tenant-a'}) =>
    _json({
      'report': {
        'tenantId': tenantId,
        'checkedAt': '2026-10-04T20:02:00.000Z',
        'deployment': {
          'provider': 'vercel',
          'environment': 'preview',
          'url': 'https://example.invalid',
          'commitSha': '0123456789012345678901234567890123456789',
          'branch': 'codex/quality-fixture',
          'region': 'example-region',
        },
        'releaseGate': {
          'approved': true,
          'status': 'warning',
          'reasons': <String>[],
          'warnings': ['Report signing: Dedicated signing is not configured.'],
          'summary': {'total': 2, 'passed': 1, 'warnings': 1, 'failures': 0},
        },
        'gates': [
          {
            'id': 'database',
            'name': 'Database',
            'status': 'pass',
            'summary': 'Database scope checks passed.',
            'details': {'privateDetails': 'not retained'},
          },
          {
            'id': 'report_signing',
            'name': 'Report signing',
            'status': 'warn',
            'summary': 'Dedicated signing is not configured.',
            'details': {'privateDetails': 'not retained'},
          },
        ],
        'tenantIsolation': {'privateUnusedIsolation': 'not retained'},
        'observability': {'privateUnusedObservability': 'not retained'},
        'recommendations': ['Configure dedicated report signing.'],
      },
    });
