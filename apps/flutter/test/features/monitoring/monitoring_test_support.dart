import 'dart:async';
import 'dart:convert';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/monitoring/monitoring_contracts.dart';
import 'package:asael/features/monitoring/monitoring_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const monitoringUser = '11111111-1111-4111-8111-111111111111';
const monitoringTime = '2026-10-05T02:00:00.000Z';
// Decoding matches transport map types, so malformed fixture writes reach the
// decoder instead of failing early against inferred Map<String, bool/int>.
Map<String, dynamic> _json(Map<String, dynamic> value) =>
    jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
Map<String, dynamic> monitoringHealthJson({String status = 'healthy'}) =>
    _json({
      'status': status,
      'checkedAt': monitoringTime,
      'requestId': 'ignored-request',
      'revision': '0123456789012345678901234567890123456789',
      'dependencies': {
        'databaseConfigured': true,
        'openAiConfigured': true,
        'cronSecretConfigured': true,
      },
    });
Map<String, dynamic> monitoringPolicyJson() => _json({
  'id': 'lcp-p75',
  'name': 'Largest Contentful Paint',
  'description': 'Main content timing over sampled page views.',
  'metric': 'lcpP75Ms',
  'unit': 'ms',
  'comparator': 'greater_than',
  'warningThreshold': 2500,
  'criticalThreshold': 4000,
  'warningSeverity': 'warning',
  'criticalSeverity': 'critical',
  'componentId': 'observability',
  'enabled': true,
  'metadata': {'minimumSamples': 20, 'unused': 'PRIVATE_METADATA'},
});
Map<String, dynamic> monitoringEvaluationJson({bool insufficient = true}) =>
    _json({
      'policy': monitoringPolicyJson(),
      'value': insufficient ? 0 : 1800,
      'breached': false,
      'margin': 0,
      'message': insufficient
          ? 'Awaiting enough sampled page views.'
          : 'Within threshold.',
      if (insufficient)
        'insufficientSamples': {'samples': 3, 'minimumSamples': 20},
    });
Map<String, dynamic> monitoringSloJson({bool insufficient = true}) => _json({
  'checkedAt': monitoringTime,
  'healthy': true,
  'stats': {
    'total': 120,
    'sloEligibleEvents': 110,
    'webVitals': {
      'LCP': {'samples': insufficient ? 3 : 30, 'p75': insufficient ? 0 : 1800},
    },
  },
  'agentQuality': {},
  'policies': [monitoringPolicyJson()],
  'evaluations': [monitoringEvaluationJson(insufficient: insufficient)],
  'breaches': <Object>[],
});
Map<String, dynamic> monitoringIncidentJson({String tenantId = 'tenant-a'}) =>
    _json({
      'id': 'incident-1',
      'tenantId': tenantId,
      'title': 'Connector response delay',
      'message': 'Recent requests exceeded the latency threshold.',
      'componentId': 'connectors',
      'severity': 'warning',
      'status': 'open',
      'occurrenceCount': 3,
      'firstSeenAt': monitoringTime,
      'lastSeenAt': monitoringTime,
      'metadata': {'private': 'PRIVATE_METADATA'},
    });
Map<String, dynamic> monitoringIncidentsJson({String tenantId = 'tenant-a'}) =>
    _json({
      'incidents': [monitoringIncidentJson(tenantId: tenantId)],
      'stats': {
        'total': 3,
        'open': 1,
        'acknowledged': 0,
        'resolved': 2,
        'active': 1,
        'criticalOpen': 0,
        'warningOpen': 1,
      },
    });
Map<String, dynamic> monitoringAlertJson({String tenantId = 'tenant-a'}) =>
    _json({
      'id': 'delivery-1',
      'tenantId': tenantId,
      'incidentId': 'incident-1',
      'targetId': 'ops-dashboard',
      'channel': 'dashboard',
      'status': 'skipped',
      'severity': 'warning',
      'attempt': 1,
      'maxAttempts': 3,
      'runAt': monitoringTime,
      'updatedAt': monitoringTime,
      'payload': {'secret': 'PRIVATE_PAYLOAD'},
      'response': {'secret': 'PRIVATE_RESPONSE'},
      'leaseOwner': 'PRIVATE_LEASE',
      'lastError': 'PRIVATE_RAW_ERROR',
    });
Map<String, dynamic> monitoringAlertsJson({String tenantId = 'tenant-a'}) =>
    _json({
      'deliveries': [monitoringAlertJson(tenantId: tenantId)],
      'stats': {
        'total': 1,
        'queued': 0,
        'running': 0,
        'delivered': 0,
        'failed': 0,
        'skipped': 1,
      },
    });
Map<String, dynamic> monitoringTimelineJson({String tenantId = 'tenant-a'}) =>
    _json({
      'events': [
        {
          'id': 'event-1',
          'tenantId': tenantId,
          'action': 'connector.read',
          'message': 'Connector read completed.',
          'level': 'info',
          'category': 'connector',
          'createdAt': monitoringTime,
          'correlationId': 'correlation-1',
          'route': '/api/connectors',
          'method': 'GET',
          'statusCode': 200,
          'durationMs': 142.4,
          'metadata': {'secret': 'PRIVATE_METADATA'},
        },
      ],
      'stats': {
        'total': 120,
        'byLevel': {'info': 115, 'warn': 4, 'error': 1},
        'p95DurationMs': 425,
      },
    });
Map<String, dynamic> monitoringResponse(String path) => switch (path) {
  '/api/health' => monitoringHealthJson(),
  '/api/observability/slo' => monitoringSloJson(),
  '/api/incidents' => monitoringIncidentsJson(),
  '/api/alerts' => monitoringAlertsJson(),
  '/api/observability' => monitoringTimelineJson(),
  _ => throw StateError('Unexpected route $path'),
};

class MonitoringTestApi extends ApiClient {
  MonitoringTestApi()
    : super(
        Dio(BaseOptions(baseUrl: 'https://workspace.example.test')),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  final paths = <String>[];
  final tokens = <CancelToken>[];
  final queries = <Map<String, dynamic>?>[];
  final authorities = <NativeRequestAuthority>[];
  Future<Map<String, dynamic>> Function(String) reader = (path) async =>
      monitoringResponse(path);
  @override
  Future<Map<String, dynamic>> getJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Map<String, dynamic>? query,
    CancelToken? cancelToken,
  }) {
    paths.add(path);
    tokens.add(cancelToken!);
    authorities.add(authority);
    queries.add(query);
    return reader(path);
  }
}

NativeWorkspaceAccess monitoringAccess(
  MonitoringTestApi api, {
  String role = 'admin',
  bool Function()? current,
}) => NativeWorkspaceAccess(
  api,
  NativeRequestAuthority(
    tenantId: 'tenant-a',
    actorId: 'owner@example.test',
    canonicalUserId: monitoringUser,
    role: role,
    apiBaseUrl: api.apiBaseUrl,
    isCurrent: current ?? () => true,
  ),
  {'operator', 'admin', 'system'}.contains(role),
);

class MonitoringRequest<T> {
  MonitoringRequest(this.cancel);
  final CancelToken cancel;
  final Completer<T> result = Completer<T>();
}

class MonitoringTestRepository implements MonitoringRepository {
  bool active = true, privateAllowed = true;
  void Function()? probe;
  Object? synchronousFailure;
  final healthRequests = <MonitoringRequest<MonitoringHealth>>[];
  final sloRequests = <MonitoringRequest<MonitoringSloSnapshot>>[];
  final incidentRequests = <MonitoringRequest<MonitoringIncidents>>[];
  final alertRequests = <MonitoringRequest<MonitoringAlerts>>[];
  final timelineRequests = <MonitoringRequest<MonitoringTimeline>>[];
  @override
  bool get current {
    probe?.call();
    return active;
  }

  @override
  bool get canReadPrivate => privateAllowed;
  Future<T> _read<T>(List<MonitoringRequest<T>> requests, CancelToken cancel) {
    if (synchronousFailure case final failure?) throw failure;
    final request = MonitoringRequest<T>(cancel);
    requests.add(request);
    return request.result.future;
  }

  @override
  Future<MonitoringHealth> health(CancelToken cancel) =>
      _read(healthRequests, cancel);
  @override
  Future<MonitoringSloSnapshot> slo(CancelToken cancel) =>
      _read(sloRequests, cancel);
  @override
  Future<MonitoringIncidents> incidents(CancelToken cancel) =>
      _read(incidentRequests, cancel);
  @override
  Future<MonitoringAlerts> alerts(CancelToken cancel) =>
      _read(alertRequests, cancel);
  @override
  Future<MonitoringTimeline> timeline(CancelToken cancel) =>
      _read(timelineRequests, cancel);
  void completeAll() {
    for (final request in healthRequests.where((r) => !r.result.isCompleted)) {
      request.result.complete(MonitoringHealth.parse(monitoringHealthJson()));
    }
    for (final request in sloRequests.where((r) => !r.result.isCompleted)) {
      request.result.complete(
        MonitoringSloSnapshot.parse(monitoringSloJson(), tenantId: 'tenant-a'),
      );
    }
    for (final request in incidentRequests.where(
      (r) => !r.result.isCompleted,
    )) {
      request.result.complete(
        MonitoringIncidents.parse(
          monitoringIncidentsJson(),
          tenantId: 'tenant-a',
        ),
      );
    }
    for (final request in alertRequests.where((r) => !r.result.isCompleted)) {
      request.result.complete(
        MonitoringAlerts.parse(monitoringAlertsJson(), tenantId: 'tenant-a'),
      );
    }
    for (final request in timelineRequests.where(
      (r) => !r.result.isCompleted,
    )) {
      request.result.complete(
        MonitoringTimeline.parse(
          monitoringTimelineJson(),
          tenantId: 'tenant-a',
        ),
      );
    }
  }
}
