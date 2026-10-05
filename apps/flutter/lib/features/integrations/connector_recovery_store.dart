import '../../core/network/native_workspace_access.dart';
import '../agents/specialist_contracts.dart';
import '../agents/specialist_recovery_store.dart';
import 'connector_contracts.dart';

abstract interface class ConnectorRecoveryStore {
  Future<ConnectorJson?> read();
  Future<void> write(ConnectorJson value, bool Function() current);
}

/// One ciphertext CAS record per API/tenant/canonical owner. Permissions are
/// revalidated on each operation and are never restored from this address.
class ProtectedConnectorRecoveryStore implements ConnectorRecoveryStore {
  ProtectedConnectorRecoveryStore(this.access, this.store)
    : owner = SpecialistOwner(access);
  final NativeWorkspaceAccess access;
  final SpecialistRecoveryStore store;
  final SpecialistOwner owner;
  static const project = 'native-connectors';
  @override
  Future<ConnectorJson?> read() async {
    connectorRequire(access.current, 'Connector recovery access changed.');
    final result = await store.read(owner, project);
    connectorRequire(access.current, 'Connector recovery access changed.');
    return result == null ? null : connectorFreeze(result);
  }

  @override
  Future<void> write(ConnectorJson value, bool Function() current) async {
    bool allowed() => access.current && current();
    connectorRequire(allowed(), 'Connector recovery access changed.');
    await store.write(
      owner,
      project,
      connectorFreeze(value),
      isCurrent: allowed,
    );
    connectorRequire(
      allowed(),
      'Connector recovery access changed after saving. Reload its exact state.',
    );
  }
}

class MemoryConnectorRecoveryStore implements ConnectorRecoveryStore {
  ConnectorJson? value;
  @override
  Future<ConnectorJson?> read() async => value;
  @override
  Future<void> write(ConnectorJson next, bool Function() current) async {
    connectorRequire(current());
    value = connectorFreeze(next);
  }
}
