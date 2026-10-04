import 'dart:async';
import 'dart:convert';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/agents/specialist_api_client.dart';
import 'package:asael/features/agents/specialist_contracts.dart';
import 'package:asael/features/agents/specialist_recovery_store.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('unknown decisions survive recreation and require fresh inspection plus an explicit new decision', () async {
    final api = _Api(),
        recovery = MemorySpecialistRecoveryStore(),
        access = _access(api);
    final client = SpecialistApiClient(access, _store(), recovery, 'agents');
    api.failWrite = true;
    await expectLater(
      client.postJson(
        '/api/agents',
        data: {'name': 'Private draft'},
        headers: {'Idempotency-Key': 'first'},
      ),
      throwsStateError,
    );
    expect(api.writes, 1);
    expect(client.journal.single['state'], 'unknown');
    final persisted = await recovery.read(SpecialistOwner(access), 'agents');
    expect(jsonEncode(persisted), isNot(contains('Private draft')));
    client.close();
    final restored = SpecialistApiClient(
      _access(api, actor: 'renamed@example.test', role: 'admin'),
      _store(),
      recovery,
      'agents',
    );
    await restored.initialize();
    api.failWrite = false;
    Future<SpecialistJson> submit() => restored.postJson(
      '/api/agents',
      data: {'name': 'Separate decision'},
      headers: {'Idempotency-Key': 'second'},
    );
    await expectLater(submit(), throwsStateError);
    await restored.inspectDecision('first');
    expect(api.reads, 1);
    await expectLater(submit(), throwsStateError);
    await restored.acknowledgeNewDecision('first');
    final response = await submit();
    await restored.acceptParsedResponse(response);
    expect(api.writes, 2);
    expect(restored.journal.first['state'], 'unknown');
    expect(restored.journal.last['state'], 'accepted');
    restored.close();
  });

  test('closing during credential admission invalidates the literal request binding before dispatch', () async {
    final api = _Api(), gate = Completer<void>();
    api.admission = gate.future;
    final client = SpecialistApiClient(
      _access(api),
      _store(),
      MemorySpecialistRecoveryStore(),
      'agents',
    );
    final operation = client.postJson(
      '/api/agents',
      data: {'name': 'One'},
      headers: {'Idempotency-Key': 'pending'},
    );
    final rejected = expectLater(operation, throwsA(anything));
    await api.admitted.future;
    client.close();
    gate.complete();
    await rejected;
    expect(api.writes, 0);
  });

  test(
    'viewer and replaced owner cannot send a specialist mutation or read',
    () async {
      final api = _Api();
      var current = true;
      final client = SpecialistApiClient(
        _access(api, role: 'viewer', current: () => current),
        _store(),
        MemorySpecialistRecoveryStore(),
        'agents',
      );
      await expectLater(
        client.postJson('/api/agents', headers: {'Idempotency-Key': 'viewer'}),
        throwsStateError,
      );
      current = false;
      await expectLater(client.getJson('/api/agents'), throwsStateError);
      expect(api.writes, 0);
      expect(api.reads, 0);
      client.close();
    },
  );
}

SecureSessionStore _store() => SecureSessionStore(const FlutterSecureStorage());
NativeWorkspaceAccess _access(
  ApiClient api, {
  String role = 'operator',
  String actor = 'owner@example.test',
  bool Function()? current,
}) => NativeWorkspaceAccess(
  api,
  NativeRequestAuthority(
    tenantId: 'tenant-specialist',
    actorId: actor,
    canonicalUserId: '11111111-1111-4111-8111-111111111111',
    role: role,
    apiBaseUrl: api.apiBaseUrl,
    isCurrent: current ?? () => true,
  ),
  role != 'viewer',
);

class _Api extends ApiClient {
  _Api() : super(Dio(), Dio(), _store());
  int reads = 0, writes = 0;
  bool failWrite = false;
  Future<void>? admission;
  final admitted = Completer<void>();
  @override
  String get apiBaseUrl => 'https://specialist.example.test';
  @override
  Future<SpecialistJson> getJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    SpecialistJson? query,
    CancelToken? cancelToken,
  }) async {
    authority.requireCurrent(apiBaseUrl);
    reads++;
    return {'agents': <Object?>[], 'builtIns': <Object?>[]};
  }

  @override
  Future<SpecialistJson> postJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    SpecialistJson? data,
    SpecialistJson? headers,
  }) async {
    if (!admitted.isCompleted) admitted.complete();
    if (admission != null) await admission;
    authority.requireCurrent(apiBaseUrl);
    writes++;
    if (failWrite) throw StateError('Response unavailable after dispatch.');
    return {
      'agent': {'id': 'accepted-agent', ...?data},
    };
  }
}
