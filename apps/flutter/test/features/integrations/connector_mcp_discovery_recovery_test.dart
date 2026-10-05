import 'dart:typed_data';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/agents/specialist_recovery_store.dart';
import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_controller.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_recovery_store.dart';
import 'package:asael/features/integrations/connector_openapi_import_recovery_store.dart';
import 'package:asael/features/integrations/connector_mcp_registration_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_fixtures.dart';
import 'connector_mcp_discovery_fixtures.dart';

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
  test('independent protected writers preserve the pending attempt across a stale close or submit', () async {
    final broker = _Broker();
    final a = ConnectorMcpDiscoveryController(
      DiscoveryFixtureRepository()..loseSubmit = true,
      ProtectedConnectorMcpDiscoveryRecoveryStore(
        _access(),
        _encrypted(broker),
      ),
    );
    final other = DiscoveryFixtureRepository();
    final b = ConnectorMcpDiscoveryController(
      other,
      ProtectedConnectorMcpDiscoveryRecoveryStore(
        _access(),
        _encrypted(broker),
      ),
    );
    await a.initialize();
    await b.initialize();
    await a.select('mcp:one');
    await b.select('mcp:one');
    await a.act(a.reviewed!, () => true);
    final original = a.sequence!.intent.keySha256;
    await b.act(b.reviewed!, () => true);
    expect(other.submits + other.closes, 0);
    expect(b.storageUnconfirmed, isTrue);
    await b.saveLocally();
    final stored = await a.store.read();
    expect(stored!['sequence']['intent']['identity']['keySha256'], original);
    expect(stored['sequence']['dispatched'], isTrue);
    expect(
      broker.values.values.single.content,
      isNot(contains('asael-connector-action-intent')),
    );
    a.dispose();
    b.dispose();
  });

  test('host ciphertext CAS also rejects a writer racing after its authenticated read', () async {
    final broker = _Broker();
    final a = ProtectedConnectorMcpDiscoveryRecoveryStore(
      _access(),
      _encrypted(broker),
    );
    final b = ProtectedConnectorMcpDiscoveryRecoveryStore(
      _access(),
      _encrypted(broker),
    );
    await a.read();
    await b.read();
    await a.write({'safe': 'original'}, () => true);
    await expectLater(
      b.write({'safe': 'competing'}, () => true),
      throwsA(isA<RecoveryStorageChanged>()),
    );
    expect((await a.read())!['safe'], 'original');
  });

  test('family recovery is independent of inventory and scoped by API tenant canonical owner and device', () async {
    final broker = _Broker();
    final stored = ProtectedConnectorMcpDiscoveryRecoveryStore(
      _access(),
      _encrypted(broker),
    );
    await stored.read();
    await stored.write({'safe': 'original'}, () => true);
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
      (await ProtectedConnectorMcpDiscoveryRecoveryStore(
        _access(owner(role: 'viewer')),
        _encrypted(broker),
      ).read())!['safe'],
      'original',
    );
    for (final scope in [
      owner(tenant: 'other'),
      owner(user: '00000000-0000-4000-8000-000000000002'),
      owner(api: 'https://other.test'),
    ]) {
      expect(
        await ProtectedConnectorMcpDiscoveryRecoveryStore(
          _access(scope),
          _encrypted(broker),
        ).read(),
        isNull,
      );
    }
    expect(
      await ProtectedConnectorMcpDiscoveryRecoveryStore(
        _access(),
        _encrypted(broker, device: 'b'),
      ).read(),
      isNull,
    );
    expect(
      await ProtectedConnectorOpenApiImportRecoveryStore(
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
