import '../../core/network/native_workspace_access.dart';
import '../agents/specialist_contracts.dart';
import '../agents/specialist_recovery_store.dart';
import 'connector_contracts.dart';

abstract interface class ConnectorCredentialRotationRecoveryStore {
  Future<ConnectorJson?> read();
  Future<void> write(ConnectorJson value, bool Function() current);
}

/// Device-protected ciphertext CAS, shared across native windows. This address
/// identifies evidence for one service/tenant/canonical user, never authority.
class ProtectedConnectorCredentialRotationRecoveryStore
    implements ConnectorCredentialRotationRecoveryStore {
  ProtectedConnectorCredentialRotationRecoveryStore(this.access, this.store)
    : owner = SpecialistOwner(access);

  final NativeWorkspaceAccess access;
  final SpecialistRecoveryStore store;
  final SpecialistOwner owner;
  static const namespace = 'native-connector-credential-rotation';

  @override
  Future<ConnectorJson?> read() async {
    connectorRequire(
      access.current,
      'Credential rotation recovery access changed.',
    );
    final value = await store.read(owner, namespace);
    connectorRequire(
      access.current,
      'Credential rotation recovery access changed.',
    );
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

    connectorRequire(allowed(), 'Credential rotation recovery access changed.');
    await store.write(
      owner,
      namespace,
      connectorFreeze(value),
      isCurrent: allowed,
    );
    connectorRequire(
      allowed(),
      'Credential rotation recovery save is unconfirmed. Read its exact protected state.',
    );
  }
}

class MemoryConnectorCredentialRotationRecoveryStore
    implements ConnectorCredentialRotationRecoveryStore {
  ConnectorJson? value;

  @override
  Future<ConnectorJson?> read() async => value;

  @override
  Future<void> write(ConnectorJson next, bool Function() current) async {
    connectorRequire(current());
    value = connectorFreeze(next);
  }
}
