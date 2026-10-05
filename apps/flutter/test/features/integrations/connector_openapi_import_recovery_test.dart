import 'dart:convert';
import 'dart:typed_data';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/agents/specialist_recovery_store.dart';
import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_openapi_import_controller.dart';
import 'package:asael/features/integrations/connector_openapi_import_recovery_store.dart';
import 'package:asael/features/integrations/connector_credential_rotation_recovery_store.dart';
import 'package:asael/features/integrations/connector_mcp_registration_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_openapi_import_fixtures.dart';
import 'connector_fixtures.dart';

class _Api extends Fake implements ApiClient {}

NativeWorkspaceAccess _access([ConnectorOwner? owner]) {
  final scope = owner ?? connectorOwner;
  return NativeWorkspaceAccess(
    _Api(),
    NativeRequestAuthority(
      tenantId: scope.tenantId,
      actorId: scope.actorId,
      canonicalUserId: scope.userId,
      role: scope.role,
      apiBaseUrl: scope.apiBaseUrl,
      isCurrent: () => true,
    ),
    false,
  );
}

class _Broker implements CiphertextRecoveryBroker {
  final values = <String, RecoveryCiphertext>{};
  String _key(RecoveryAddress a) =>
      '${a.namespace.name}/${a.secretId}/${a.recordKey}';
  @override
  Future<RecoveryCiphertext> read(RecoveryAddress a) async =>
      values[_key(a)] ?? const RecoveryCiphertext(null, null);
  @override
  Future<String> compareAndSwap(
    RecoveryAddress a, {
    required String? expectedSha256,
    required String ciphertext,
  }) async {
    if (values[_key(a)]?.sha256 != expectedSha256) {
      throw const RecoveryStorageChanged();
    }
    final sha = await recoveryCiphertextHash(ciphertext);
    values[_key(a)] = RecoveryCiphertext(ciphertext, sha);
    return sha;
  }
}

EncryptedSpecialistRecoveryStore _encrypted(
  _Broker broker, {
  String device = 'a',
}) => EncryptedSpecialistRecoveryStore(
  () async => DeviceSecretMaterial(
    id: device * 24,
    bytes: Uint8List.fromList(List.filled(32, device.codeUnitAt(0))),
  ),
  broker: broker,
);

void main() {
  test('separate encrypted writers cannot abandon or overwrite another window final dispatch', () async {
    final broker = _Broker(),
        firstRepository = ImportFixtureRepository()..loseSubmit = true;
    final first = ConnectorOpenApiImportController(
      firstRepository,
      ProtectedConnectorOpenApiImportRecoveryStore(
        _access(),
        _encrypted(broker),
      ),
      now: () => importNow,
    );
    await first.initialize();
    await first.prepare(
      importDeclaration(),
      importPayload(),
      () => true,
      clearSecret: () {},
    );
    final secondRepository = ImportFixtureRepository();
    final secondStore = ProtectedConnectorOpenApiImportRecoveryStore(
      _access(),
      _encrypted(broker),
    );
    final second = ConnectorOpenApiImportController(
      secondRepository,
      secondStore,
      now: () => importNow,
    );
    await second.initialize();
    await first.confirm(first.sequence!, () => true);
    final finalKey = first.sequence!.finalIntent!.keySha256;
    await second.abandon(() => true);
    expect(secondRepository.abandons, 0);
    expect(second.storageUnconfirmed, isTrue);
    await second.saveLocally();
    final persisted = await secondStore.read();
    expect(
      persisted!['sequence']['finalIntent']['identity']['keySha256'],
      finalKey,
    );
    expect(persisted['sequence']['abandonDispatched'], isFalse);
    expect(jsonEncode(persisted), isNot(contains(importText)));
    expect(jsonEncode(persisted), isNot(contains('synthetic-private-query')));
    expect(
      broker.values.values.single.content,
      isNot(contains('asael-openapi-import-preparation-intent')),
    );
    first.dispose();
    second.dispose();
  });

  test('import journal is isolated by API tenant canonical owner and device, survives role loss and is distinct from credential rotation', () async {
    final broker = _Broker();
    // All addresses under test share one host broker.
    final base = ProtectedConnectorOpenApiImportRecoveryStore(
      _access(),
      _encrypted(broker),
    );
    await base.read();
    await base.write({'safe': 'recovery'}, () => true);
    ConnectorOwner owner({
      String? tenant,
      String? user,
      String? api,
      String? role,
    }) => ConnectorOwner(
      tenantId: tenant ?? connectorOwner.tenantId,
      actorId: connectorOwner.actorId,
      userId: user ?? connectorOwner.userId,
      role: role ?? connectorOwner.role,
      apiBaseUrl: api ?? connectorOwner.apiBaseUrl,
    );
    expect(
      (await ProtectedConnectorOpenApiImportRecoveryStore(
        _access(owner(role: 'viewer')),
        _encrypted(broker),
      ).read())!['safe'],
      'recovery',
    );
    for (final scope in [
      owner(tenant: 'other'),
      owner(user: '00000000-0000-4000-8000-000000000002'),
      owner(api: 'https://other.test'),
    ]) {
      expect(
        await ProtectedConnectorOpenApiImportRecoveryStore(
          _access(scope),
          _encrypted(broker),
        ).read(),
        isNull,
      );
    }
    expect(
      await ProtectedConnectorOpenApiImportRecoveryStore(
        _access(),
        _encrypted(broker, device: 'b'),
      ).read(),
      isNull,
    );
    expect(
      await ProtectedConnectorCredentialRotationRecoveryStore(
        _access(),
        _encrypted(broker),
      ).read(),
      isNull,
    );
    expect(
      await ProtectedConnectorMcpRegistrationRecoveryStore(
        _access(),
        _encrypted(broker),
      ).read(),
      isNull,
    );
    expect(broker.values.length, 1);
  });
}
