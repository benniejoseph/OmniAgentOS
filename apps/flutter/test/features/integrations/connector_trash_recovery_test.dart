import 'dart:typed_data';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/agents/specialist_recovery_store.dart';
import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_trash_controller.dart';
import 'package:asael/features/integrations/connector_trash_recovery_store.dart';
import 'package:asael/features/integrations/connector_recovery_store.dart';
import 'package:asael/features/integrations/connector_credential_removal_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_trash_fixtures.dart';
import 'connector_fixtures.dart';

class _Api extends Fake implements ApiClient {}

NativeWorkspaceAccess _access({ConnectorOwner? owner}) {
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
  String _key(RecoveryAddress address) =>
      '${address.namespace.name}/${address.secretId}/${address.recordKey}';
  @override
  Future<RecoveryCiphertext> read(RecoveryAddress address) async =>
      values[_key(address)] ?? const RecoveryCiphertext(null, null);
  @override
  Future<String> compareAndSwap(
    RecoveryAddress address, {
    required String? expectedSha256,
    required String ciphertext,
  }) async {
    if (values[_key(address)]?.sha256 != expectedSha256) {
      throw const RecoveryStorageChanged();
    }
    final hash = await recoveryCiphertextHash(ciphertext);
    values[_key(address)] = RecoveryCiphertext(ciphertext, hash);
    return hash;
  }
}

EncryptedSpecialistRecoveryStore _encrypted(
  _Broker broker, {
  String device = 'a',
}) => EncryptedSpecialistRecoveryStore(
  () async => DeviceSecretMaterial(
    id: device * 24,
    bytes: Uint8List.fromList(List<int>.filled(32, device.codeUnitAt(0))),
  ),
  broker: broker,
);

void main() {
  test('two native windows cannot replace a competing protected Trash slot across different targets', () async {
    final broker = _Broker();
    final firstRepository = TrashFixtureRepository(),
        secondRepository = TrashFixtureRepository();
    final first = ConnectorTrashController(
      firstRepository,
      ProtectedConnectorTrashRecoveryStore(_access(), _encrypted(broker)),
      now: () => trashNow,
    );
    final second = ConnectorTrashController(
      secondRepository,
      ProtectedConnectorTrashRecoveryStore(_access(), _encrypted(broker)),
      now: () => trashNow,
    );
    await first.initialize();
    await second.initialize();
    await first.select('mcp:one');
    await second.select('mcp:two');
    await first.act(first.reviewed!, () => true);
    final acceptedKey = first.accepted!.intent.key;
    await second.act(second.reviewed!, () => true);
    expect(firstRepository.posts, 1);
    expect(secondRepository.posts, 0);
    expect(second.pending!.dispatched, isFalse);
    expect(second.storageUnconfirmed, isTrue);
    await second.reloadProtected();
    expect(second.pending, isNull);
    expect(second.accepted!.intent.key, acceptedKey);
    expect(second.storageUnconfirmed, isFalse);
    expect(secondRepository.posts, 0);
    expect(
      broker.values.values.single.content,
      isNot(contains('asael-connector-lifecycle-action')),
    );
    first.dispose();
    second.dispose();
  });

  test('one protected Trash namespace separates device, service, tenant and owner, survives role loss, and cannot read v40/v41', () async {
    final broker = _Broker();
    // Use one shared broker for every scope check; unrelated scopes must find no evidence.
    final protected = _encrypted(broker);
    final first = ProtectedConnectorTrashRecoveryStore(_access(), protected);
    await first.read();
    await first.write({'proof': 'exact target evidence'}, () => true);
    final roleChanged = ConnectorOwner(
      tenantId: connectorOwner.tenantId,
      actorId: connectorOwner.actorId,
      userId: connectorOwner.userId,
      role: 'viewer',
      apiBaseUrl: connectorOwner.apiBaseUrl,
    );
    expect(
      (await ProtectedConnectorTrashRecoveryStore(
        _access(owner: roleChanged),
        _encrypted(broker),
      ).read())!['proof'],
      'exact target evidence',
    );
    expect(
      await ProtectedConnectorTrashRecoveryStore(
        _access(),
        _encrypted(broker, device: 'b'),
      ).read(),
      isNull,
    );
    for (final owner in [
      ConnectorOwner(
        tenantId: 'another-tenant',
        actorId: connectorOwner.actorId,
        userId: connectorOwner.userId,
        role: connectorOwner.role,
        apiBaseUrl: connectorOwner.apiBaseUrl,
      ),
      ConnectorOwner(
        tenantId: connectorOwner.tenantId,
        actorId: connectorOwner.actorId,
        userId: '00000000-0000-4000-8000-000000000002',
        role: connectorOwner.role,
        apiBaseUrl: connectorOwner.apiBaseUrl,
      ),
      ConnectorOwner(
        tenantId: connectorOwner.tenantId,
        actorId: connectorOwner.actorId,
        userId: connectorOwner.userId,
        role: connectorOwner.role,
        apiBaseUrl: 'https://other.example.test',
      ),
    ]) {
      expect(
        await ProtectedConnectorTrashRecoveryStore(
          _access(owner: owner),
          protected,
        ).read(),
        isNull,
      );
    }
    expect(broker.values.length, 1);
    expect(
      await ProtectedConnectorCredentialRemovalRecoveryStore(
        _access(),
        protected,
        'mcp:one',
      ).read(),
      isNull,
    );
    expect(
      await ProtectedConnectorRecoveryStore(_access(), protected).read(),
      isNull,
    );
  });
}
