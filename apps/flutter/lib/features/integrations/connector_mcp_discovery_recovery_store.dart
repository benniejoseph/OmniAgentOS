import '../../core/network/native_workspace_access.dart';
import '../agents/specialist_contracts.dart';
import '../agents/specialist_recovery_store.dart';
import 'connector_contracts.dart';

abstract interface class ConnectorMcpDiscoveryRecoveryStore {
  Future<ConnectorJson?> read();
  Future<void> write(ConnectorJson value, bool Function() current);
}

/// Device-protected ciphertext CAS, shared across native windows. This address
/// identifies evidence for one service/tenant/canonical user, never authority.
class ProtectedConnectorMcpDiscoveryRecoveryStore
    implements ConnectorMcpDiscoveryRecoveryStore {
  ProtectedConnectorMcpDiscoveryRecoveryStore(this.access, this.store)
    : owner = SpecialistOwner(access);

  final NativeWorkspaceAccess access;
  final SpecialistRecoveryStore store;
  final SpecialistOwner owner;
  static const namespace = 'native-connector-mcp-discovery';

  @override
  Future<ConnectorJson?> read() async {
    connectorRequire(access.current, 'MCP discovery recovery access changed.');
    final value = await store.read(owner, namespace);
    connectorRequire(access.current, 'MCP discovery recovery access changed.');
    return value == null ? null : connectorFreeze(value);
  }

  @override
  Future<void> write(ConnectorJson value, bool Function() current) async {
    bool allowed() {
      if (!current() || !access.current) {
        return false;
      }
      return current();
    }

    connectorRequire(allowed(), 'MCP discovery recovery access changed.');
    await store.write(
      owner,
      namespace,
      connectorFreeze(value),
      isCurrent: allowed,
    );
    connectorRequire(
      allowed(),
      'MCP discovery recovery save is unconfirmed. Read its exact protected state.',
    );
  }
}

class MemoryConnectorMcpDiscoveryRecoveryStore
    implements ConnectorMcpDiscoveryRecoveryStore {
  ConnectorJson? value;

  @override
  Future<ConnectorJson?> read() async => value;

  @override
  Future<void> write(ConnectorJson next, bool Function() current) async {
    connectorRequire(current());
    value = connectorFreeze(next);
  }
}
