import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/companion/companion_models.dart';
import 'package:asael/features/companion/companion_repository.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'companion_fixtures.dart';

const _scope = (
  deployment: 'https://test.invalid',
  tenantId: 'tenant',
  actorId: 'actor',
  role: 'viewer',
);

class _Api extends Fake implements ApiClient {
  final reads =
      <({String path, Map<String, dynamic>? headers, CancelToken cancel})>[];
  final writes =
      <
        ({
          String path,
          Map<String, dynamic>? headers,
          Map<String, dynamic>? body,
        })
      >[];
  Map<String, dynamic> bootstrap = {
    'authenticated': true,
    'context': {'tenantId': 'tenant', 'actorId': 'actor', 'role': 'viewer'},
    'membership': {'role': 'viewer'},
    'permissions': ['manage.own_preferences'],
    'api': {
      'nativeContract': {
        'id': NativeContract.id,
        'supportedVersions': [NativeContract.currentVersion],
      },
    },
    'nativeClientPolicy': {
      'mutationCapabilities': {
        'companion.preferences.update': {
          'state': 'active',
          'minimumContractVersion': 31,
        },
      },
    },
  };
  Map<String, dynamic> patchResponse = {};
  @override
  Future<Map<String, dynamic>> getJsonFreshCancelable(
    String path, {
    Map<String, dynamic>? query,
    Map<String, dynamic>? headers,
    required CancelToken cancelToken,
  }) async {
    reads.add((path: path, headers: headers, cancel: cancelToken));
    return path == NativePaths.bootstrapGet ? bootstrap : companionFixture();
  }

  @override
  Future<Map<String, dynamic>> patchJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    writes.add((path: path, headers: headers, body: data));
    return patchResponse;
  }
}

void main() {
  test(
    'fresh private read sends expected owner digest and never uses cached GET',
    () async {
      final api = _Api();
      final repository = ApiCompanionRepository(api, _scope);
      final cancel = CancelToken();
      await repository.read(cancel);
      expect(api.reads.single.path, NativePaths.companionPreferencesGet);
      expect(api.reads.single.cancel, same(cancel));
      expect(
        api.reads.single.headers!['x-asael-companion-owner-sha256'],
        await companionOwnerDigest('tenant', 'actor'),
      );
      expect(
        await companionOwnerDigest('tenant', 'actor'),
        isNot(await companionOwnerDigest('tenant', 'other')),
      );
      expect(api.writes, isEmpty);
    },
  );
  test('viewer enrollment is explicit and bootstrap owner/role mismatch is rejected', () async {
    final api = _Api();
    final repository = ApiCompanionRepository(api, _scope);
    expect((await repository.readPolicy(CancelToken())).active, true);
    (api.bootstrap['membership'] as Map)['role'] = 'admin';
    await expectLater(
      repository.readPolicy(CancelToken()),
      throwsFormatException,
    );
    (api.bootstrap['membership'] as Map)['role'] = 'viewer';
    (api.bootstrap['context'] as Map)['actorId'] = 'other';
    await expectLater(
      repository.readPolicy(CancelToken()),
      throwsFormatException,
    );
  });
  test('missing capability never enables native writes', () async {
    final api = _Api()
      ..bootstrap['nativeClientPolicy'] = {'mutationCapabilities': {}};
    expect(
      (await ApiCompanionRepository(api, _scope).readPolicy(CancelToken()))
          .active,
      false,
    );
  });
  test('PATCH uses generated operation, exact body/key/owner and validates accepted receipt', () async {
    final api = _Api();
    final repository = ApiCompanionRepository(api, _scope);
    final submitted = CompanionSubmission(
      key: 'fixture-key',
      expectedRevision: 0,
      draftAtStart: const CompanionPreferences(intensity: 'quiet'),
    );
    api.patchResponse = companionFixture(
      revision: 1,
      preferences: submitted.submitted,
      submission: submitted,
    );
    final receipt = await repository.submit(submitted);
    expect(receipt.receipt!.revision, 1);
    expect(api.writes.single.path, NativePaths.companionPreferencesUpdate);
    expect(api.writes.single.body, submitted.toJson());
    expect(api.writes.single.headers!['Idempotency-Key'], 'fixture-key');
    expect(
      api.writes.single.headers!['x-asael-companion-owner-sha256'],
      await companionOwnerDigest('tenant', 'actor'),
    );
    api.patchResponse = {};
    await expectLater(repository.submit(submitted), throwsFormatException);
  });
}
