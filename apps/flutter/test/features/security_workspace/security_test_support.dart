import 'dart:async';
import 'dart:convert';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/security/security_contracts.dart';
import 'package:asael/features/security/security_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const securityUser = '11111111-1111-4111-8111-111111111111';
const securityTime = '2026-10-05T02:00:00.000Z';
Map<String, dynamic> _json(Map<String, dynamic> value) =>
    jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
Map<String, dynamic> securityRuleJson({String action = 'read.security'}) =>
    _json({
      'action': action,
      'description': 'Read tenant security evidence.',
      'roles': ['admin', 'system'],
    });
Map<String, dynamic> securityContextJson({String role = 'admin'}) => _json({
  'context': {
    'tenantId': 'tenant-a',
    'actorId': 'owner@example.test',
    'role': role,
    'source': 'mobile',
    'auth': {
      'userId': securityUser,
      'sessionId': 'PRIVATE_SESSION',
      'email': 'owner@example.test',
    },
    'native': {'deviceId': 'PRIVATE_DEVICE'},
  },
  'policy': {
    'rbacRules': [
      securityRuleJson(),
      {
        'action': 'read.context',
        'description': 'Read the current access context.',
        'roles': ['viewer', 'operator', 'admin', 'system'],
      },
    ],
    'secretVault': {'secret': 'PRIVATE_VAULT'},
  },
  'stats': {'secret': 'PRIVATE_CONTEXT_STATS'},
});
Map<String, dynamic> securityAuditJson({
  String id = 'audit-1',
  String tenant = 'tenant-a',
}) => _json({
  'id': id,
  'tenantId': tenant,
  'actorId': 'other@example.test',
  'actorRole': 'operator',
  'action': 'connector.read',
  'resourceType': 'connector',
  'resourceId': 'connector-7',
  'decision': 'deny',
  'reason': 'The requested scope is unavailable.',
  'riskLevel': 1,
  'createdAt': securityTime,
  'metadata': {'private': 'PRIVATE_METADATA'},
});
Map<String, dynamic> securityAuditsJson() => _json({
  'records': [securityAuditJson()],
  'stats': {
    'total': 120,
    'byDecision': {'allow': 115, 'deny': 5},
    'byRole': {'admin': 110, 'operator': 10},
    'latest': [
      {'metadata': 'PRIVATE_LATEST'},
    ],
  },
});
Map<String, dynamic> securityTableJson({
  String name = 'omni_items',
  String category = 'root',
  bool pass = true,
}) => _json({
  'tableName': name,
  'category': category,
  'exists': pass,
  'tenantColumn': pass,
  'rlsEnabled': pass,
  'forceRls': pass,
  'policyPresent': pass,
  'status': pass ? 'pass' : 'fail',
});
Map<String, dynamic> securityIsolationJson({
  bool configured = true,
  bool failedChild = false,
  bool unclassified = false,
}) {
  final tables = [
    securityTableJson(pass: configured),
    securityTableJson(
      name: 'omni_item_children',
      category: 'child',
      pass: configured && !failedChild,
    ),
  ];
  final failing = tables
      .where((table) => table['status'] == 'fail')
      .map((table) => table['tableName'])
      .toList();
  return _json({
    'report': {
      'tenantId': 'tenant-a',
      'checkedAt': securityTime,
      'storageBackend': configured ? 'postgres' : 'file',
      'databaseConfigured': configured,
      'status': !configured
          ? 'not_configured'
          : failedChild || unclassified
          ? 'degraded'
          : 'passing',
      'summary': {
        'expectedTables': 2,
        'protectedTables': 2 - failing.length,
        'failingTables': failing.length,
        'childTables': configured && failedChild ? 0 : 1,
        'unclassifiedTables': unclassified ? ['omni_unclassified'] : [],
        'missingTables': failing,
        'missingTenantColumns': failing,
        'rlsDisabled': failing,
        'forceRlsDisabled': failing,
        'missingPolicies': failing,
      },
      'tables': tables,
      'latestEval': {
        'runId': 'isolation-run-1',
        'runStatus': 'completed',
        'resultStatus': 'fail',
        'score': 0,
        'createdAt': '2026-10-01T02:00:00.000Z',
        'completedAt': '2026-10-01T02:00:03.000Z',
      },
      'recommendations': [
        'Review the dated isolation evaluation before release.',
      ],
    },
  });
}

Map<String, dynamic> securityRetentionJson({bool postgres = true}) => _json({
  'policy': {
    for (final window in SecurityRetentionWindow.values) window.name: 30,
  },
  'backend': postgres ? 'postgres' : 'bounded_local',
  'automaticSweep': postgres,
});
Map<String, dynamic> securityResponse(String path) => switch (path) {
  '/api/security/context' => securityContextJson(),
  '/api/security/audits' => securityAuditsJson(),
  '/api/security/isolation-report' => securityIsolationJson(),
  '/api/security/retention' => securityRetentionJson(),
  _ => throw StateError('Unexpected Security route $path'),
};
SecurityAccessContext securityContext({String role = 'admin'}) =>
    SecurityAccessContext.parse(
      securityContextJson(role: role),
      tenantId: 'tenant-a',
      actorId: 'owner@example.test',
      userId: securityUser,
      role: role,
    );

class SecurityTestApi extends ApiClient {
  SecurityTestApi()
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
      securityResponse(path);
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

NativeWorkspaceAccess securityAccess(
  SecurityTestApi api, {
  String role = 'admin',
  bool Function()? current,
}) => NativeWorkspaceAccess(
  api,
  NativeRequestAuthority(
    tenantId: 'tenant-a',
    actorId: 'owner@example.test',
    canonicalUserId: securityUser,
    role: role,
    apiBaseUrl: api.apiBaseUrl,
    isCurrent: current ?? () => true,
  ),
  {'operator', 'admin', 'system'}.contains(role),
);

class SecurityRequest<T> {
  SecurityRequest(this.cancel);
  final CancelToken cancel;
  final Completer<T> result = Completer<T>();
}

class SecurityTestRepository implements SecurityRepository {
  bool active = true, privateAllowed = true;
  void Function()? probe;
  Object? synchronousFailure;
  final contextRequests = <SecurityRequest<SecurityAccessContext>>[];
  final auditRequests = <SecurityRequest<SecurityAudits>>[];
  final isolationRequests = <SecurityRequest<SecurityIsolation>>[];
  final retentionRequests = <SecurityRequest<SecurityRetention>>[];
  @override
  bool get current {
    probe?.call();
    return active;
  }

  @override
  bool get canReadPrivate => privateAllowed;
  Future<T> _read<T>(List<SecurityRequest<T>> requests, CancelToken cancel) {
    if (synchronousFailure case final failure?) throw failure;
    final request = SecurityRequest<T>(cancel);
    requests.add(request);
    return request.result.future;
  }

  @override
  Future<SecurityAccessContext> context(CancelToken cancel) =>
      _read(contextRequests, cancel);
  @override
  Future<SecurityAudits> audits(CancelToken cancel) =>
      _read(auditRequests, cancel);
  @override
  Future<SecurityIsolation> isolation(CancelToken cancel) =>
      _read(isolationRequests, cancel);
  @override
  Future<SecurityRetention> retention(CancelToken cancel) =>
      _read(retentionRequests, cancel);
  void completeAll() {
    for (final request in contextRequests.where(
      (request) => !request.result.isCompleted,
    )) {
      request.result.complete(
        securityContext(role: privateAllowed ? 'admin' : 'operator'),
      );
    }
    for (final request in auditRequests.where(
      (request) => !request.result.isCompleted,
    )) {
      request.result.complete(
        SecurityAudits.parse(securityAuditsJson(), tenantId: 'tenant-a'),
      );
    }
    for (final request in isolationRequests.where(
      (request) => !request.result.isCompleted,
    )) {
      request.result.complete(
        SecurityIsolation.parse(securityIsolationJson(), tenantId: 'tenant-a'),
      );
    }
    for (final request in retentionRequests.where(
      (request) => !request.result.isCompleted,
    )) {
      request.result.complete(SecurityRetention.parse(securityRetentionJson()));
    }
  }
}
