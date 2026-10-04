import 'dart:convert';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/security/security_controller.dart';
import 'package:asael/features/security/security_repository.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'security_test_support.dart';

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  for (final refusal in ['canonical owner', 'bootstrap401']) {
    test(
      'real transport $refusal refusal clears all Security lanes without dispatch or replay',
      () async {
        final service = _SecurityService(), store = await _store();
        final repo = _repository(store, service);
        final c = SecurityController(repo);
        addTearDown(() {
          c.dispose();
          repo.dispose();
        });
        await c.refresh();
        c.select('read.security');
        expect(c.context.data, isNotNull);
        expect(c.audits.data, isNotNull);
        expect(c.isolation.data, isNotNull);
        expect(c.retention.data, isNotNull);
        if (refusal == 'canonical owner') {
          service.owner = '22222222-2222-4222-8222-222222222222';
        } else {
          service.bootstrapStatus = 401;
        }
        await c.refreshSource(SecuritySource.retention);
        expect(c.authorizationDenied, isTrue);
        expect(c.available, isFalse);
        expect(c.selectedId, isNull);
        for (final source in SecuritySource.values) {
          expect(c.lane(source).data, isNull);
        }
        expect(service.requests, hasLength(4));
        expect(
          service.requests.map((request) => request.method),
          everyElement('GET'),
        );
        expect(service.refreshes, 0);
        expect(service.bootstraps, 5);
        await c.refresh();
        expect(service.bootstraps, 5);
      },
    );
  }
  test('real transport bootstrap500 remains one unavailable source and preserves other current evidence', () async {
    final service = _SecurityService(), store = await _store();
    final repo = _repository(store, service);
    final controller = SecurityController(repo);
    addTearDown(() {
      controller.dispose();
      repo.dispose();
    });
    await controller.refresh();
    service.bootstrapStatus = 500;
    await controller.refreshSource(SecuritySource.retention);
    expect(controller.authorizationDenied, isFalse);
    expect(controller.available, isTrue);
    expect(controller.retention.state, SecurityLoadState.failed);
    expect(controller.context.data, isNotNull);
    expect(controller.audits.data, isNotNull);
    expect(controller.isolation.data, isNotNull);
    expect(service.requests, hasLength(4));
    expect(service.refreshes, 0);
    service.bootstrapStatus = 200;
    await controller.refreshSource(SecuritySource.retention);
    expect(controller.retention.state, SecurityLoadState.ready);
    expect(service.requests, hasLength(5));
  });
}

Future<SecureSessionStore> _store() async {
  final store = SecureSessionStore(const FlutterSecureStorage());
  await store.writeTokens(
    accessToken: 'security-test-access',
    refreshToken: 'security-test-refresh',
    accessExpiresAt: DateTime.now()
        .toUtc()
        .add(const Duration(minutes: 15))
        .toIso8601String(),
  );
  return store;
}

ApiSecurityRepository _repository(
  SecureSessionStore store,
  _SecurityService service,
) {
  Dio client() =>
      Dio(BaseOptions(baseUrl: 'https://security-transport.test'))
        ..httpClientAdapter = service;
  final api = createApiClient(store, dio: client(), refreshDio: client());
  return ApiSecurityRepository(
    NativeWorkspaceAccess(
      api,
      NativeRequestAuthority(
        tenantId: 'tenant-a',
        actorId: 'owner@example.test',
        canonicalUserId: securityUser,
        role: 'admin',
        apiBaseUrl: api.apiBaseUrl,
        isCurrent: () => true,
      ),
      true,
    ),
  );
}

class _SecurityService implements HttpClientAdapter {
  String owner = securityUser;
  int bootstrapStatus = 200, bootstraps = 0, refreshes = 0;
  final requests = <({String path, String method})>[];
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (options.uri.path == NativePaths.bootstrapGet) {
      bootstraps++;
      return _response(bootstrapStatus, {
        'authenticated': true,
        'context': {
          'tenantId': 'tenant-a',
          'actorId': 'owner@example.test',
          'role': 'admin',
        },
        'user': {'id': owner, 'email': 'owner@example.test'},
        'membership': {'role': 'admin'},
      });
    }
    if (options.uri.path == NativePaths.authRefresh) {
      refreshes++;
      return _response(500, {'error': 'Unexpected refresh'});
    }
    requests.add((path: options.uri.path, method: options.method));
    return _response(200, securityResponse(options.uri.path));
  }

  ResponseBody _response(int status, Object? body) => ResponseBody.fromString(
    jsonEncode(body),
    status,
    headers: {
      Headers.contentTypeHeader: ['application/json'],
    },
  );
  @override
  void close({bool force = false}) {}
}
