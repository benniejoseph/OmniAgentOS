import '../../core/network/native_workspace_access.dart';
import '../agents/specialist_contracts.dart';
import '../agents/specialist_recovery_store.dart';
import 'connector_contracts.dart';

abstract interface class ConnectorGithubUpgradeRecoveryStore {
  Future<ConnectorJson?> read();
  Future<void> write(ConnectorJson value, bool Function() current);
}

/// Protected evidence for one service, tenant and canonical owner. The slot is
/// independent of discovery and other connector action families.
class ProtectedConnectorGithubUpgradeRecoveryStore
    implements ConnectorGithubUpgradeRecoveryStore {
  ProtectedConnectorGithubUpgradeRecoveryStore(this.access, this.store)
    : owner = SpecialistOwner(access);

  final NativeWorkspaceAccess access;
  final SpecialistRecoveryStore store;
  final SpecialistOwner owner;
  static const namespace = 'native-connector-github-upgrade';

  @override
  Future<ConnectorJson?> read() async {
    connectorRequire(access.current, 'GitHub upgrade recovery access changed.');
    final value = await store.read(owner, namespace);
    connectorRequire(access.current, 'GitHub upgrade recovery access changed.');
    return value == null ? null : connectorFreeze(value);
  }

  @override
  Future<void> write(ConnectorJson value, bool Function() current) async {
    bool allowed() {
      if (!current() || !access.current) return false;
      return current();
    }

    connectorRequire(allowed(), 'GitHub upgrade recovery access changed.');
    await store.write(
      owner,
      namespace,
      connectorFreeze(value),
      isCurrent: allowed,
    );
    connectorRequire(
      allowed(),
      'GitHub upgrade recovery save is unconfirmed. Read its protected state.',
    );
  }
}

class MemoryConnectorGithubUpgradeRecoveryStore
    implements ConnectorGithubUpgradeRecoveryStore {
  ConnectorJson? value;

  @override
  Future<ConnectorJson?> read() async => value;

  @override
  Future<void> write(ConnectorJson next, bool Function() current) async {
    connectorRequire(current());
    value = connectorFreeze(next);
  }
}
