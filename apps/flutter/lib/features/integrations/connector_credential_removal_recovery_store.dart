import '../../core/network/native_workspace_access.dart';
import '../agents/specialist_contracts.dart';
import '../agents/specialist_recovery_store.dart';
import 'connector_contracts.dart';
import 'connector_control_contracts.dart';

abstract interface class ConnectorCredentialRemovalRecoveryStore {
  Future<ConnectorJson?> read();
  Future<void> write(ConnectorJson value, bool Function() current);
}

/// Device-protected ciphertext CAS, shared across native windows. This address
/// identifies evidence for one service/tenant/canonical user/target, never authority.
class ProtectedConnectorCredentialRemovalRecoveryStore
    implements ConnectorCredentialRemovalRecoveryStore {
  ProtectedConnectorCredentialRemovalRecoveryStore(
    this.access,
    this.store,
    String connectorId,
  ) : owner = SpecialistOwner(access),
      connectorId = controlId(connectorId);

  final NativeWorkspaceAccess access;
  final SpecialistRecoveryStore store;
  final SpecialistOwner owner;
  final String connectorId;
  static const namespace = 'native-credential-removal';
  Future<String> get _project async =>
      '$namespace:${await connectorRawSha(connectorId)}';

  @override
  Future<ConnectorJson?> read() async {
    connectorRequire(
      access.current,
      'Connector credential recovery access changed.',
    );
    final project = await _project;
    connectorRequire(
      access.current,
      'Connector credential recovery access changed.',
    );
    final value = await store.read(owner, project);
    connectorRequire(
      access.current,
      'Connector credential recovery access changed.',
    );
    return value == null ? null : connectorFreeze(value);
  }

  @override
  Future<void> write(ConnectorJson value, bool Function() current) async {
    bool allowed() {
      if (!current() || !access.current) return false;
      return current();
    }

    connectorRequire(
      allowed(),
      'Connector credential recovery access changed.',
    );
    final project = await _project;
    connectorRequire(
      allowed(),
      'Connector credential recovery access changed.',
    );
    await store.write(
      owner,
      project,
      connectorFreeze(value),
      isCurrent: allowed,
    );
    connectorRequire(
      allowed(),
      'Connector credential recovery save is unconfirmed. Read its exact protected state.',
    );
  }
}

class MemoryConnectorCredentialRemovalRecoveryStore
    implements ConnectorCredentialRemovalRecoveryStore {
  ConnectorJson? value;

  @override
  Future<ConnectorJson?> read() async => value;

  @override
  Future<void> write(ConnectorJson next, bool Function() current) async {
    connectorRequire(current());
    value = connectorFreeze(next);
  }
}
