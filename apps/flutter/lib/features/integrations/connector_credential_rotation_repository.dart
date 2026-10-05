import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'connector_contracts.dart';
import 'connector_control_contracts.dart';
import 'connector_credential_rotation_contracts.dart';

abstract interface class ConnectorCredentialRotationRepository {
  ConnectorOwner get owner;
  bool get current;
  Future<ConnectorReview> review(String id);
  Future<ConnectorCredentialPreparationRead> prepare(
    ConnectorCredentialPreparationIntent intent,
    String token,
    bool Function() admission,
  );
  Future<ConnectorCredentialPreparationRead> readPreparation(
    ConnectorCredentialPreparationIntent intent,
  );
  Future<ConnectorCredentialPreparationRead> abandon(
    ConnectorCredentialPreparationIntent intent,
    bool Function() admission,
  );
  Future<ConnectorCredentialRotationRead> submit(
    ConnectorCredentialRotationIntent intent,
    bool Function() admission,
  );
  Future<ConnectorCredentialRotationRead> readAction(
    ConnectorCredentialRotationIntent intent,
  );
  void close();
}

class ApiConnectorCredentialRotationRepository
    implements ConnectorCredentialRotationRepository {
  ApiConnectorCredentialRotationRepository(this.access, {this.isCurrent})
    : owner = ConnectorOwner.fromAccess(access);
  final NativeWorkspaceAccess access;
  final bool Function()? isCurrent;
  @override
  final ConnectorOwner owner;
  final _reads = CancelToken();
  bool _open = true;
  @override
  bool get current {
    if (!_open) {
      return false;
    }
    if (!(isCurrent?.call() ?? true) || !_open) {
      close();
      return false;
    }
    final allowed = access.current;
    if (!_open || !allowed || !(isCurrent?.call() ?? true) || !_open) {
      close();
      return false;
    }
    return true;
  }

  bool _admitted(bool Function()? admission) {
    if (!current || !(admission?.call() ?? true)) {
      return false;
    }
    return current;
  }

  NativeRequestAuthority _authority([bool Function()? admission]) =>
      NativeRequestAuthority(
        tenantId: owner.tenantId,
        actorId: owner.actorId,
        canonicalUserId: owner.userId,
        role: owner.role,
        apiBaseUrl: owner.apiBaseUrl,
        isCurrent: () => _admitted(admission),
      );
  void _check() =>
      connectorRequire(current, 'Credential recovery access changed.');
  void _owner(
    ConnectorCredentialPreparationIntent intent, {
    bool management = false,
  }) {
    _check();
    connectorRequire(
      owner.storageKey == intent.owner.storageKey &&
          connectorSame(owner.scope, intent.owner.scope),
    );
    if (management) {
      connectorRequire(
        owner.key == intent.owner.key &&
            const ['admin', 'system'].contains(owner.role),
      );
    }
  }

  Future<ConnectorJson> _request(
    Future<ConnectorJson> Function() operation,
  ) async {
    try {
      return await operation();
    } catch (error) {
      if (error is NativeAuthorityVerificationException ||
          error is ApiException &&
              const [401, 403].contains(error.statusCode)) {
        close();
      }
      rethrow;
    }
  }

  @override
  Future<ConnectorReview> review(String id) async {
    _check();
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.connectorsNativeReview('mcp', controlId(id)),
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await ConnectorReview.parse(value, owner, 'mcp', id);
    _check();
    return result;
  }

  @override
  Future<ConnectorCredentialPreparationRead> prepare(
    ConnectorCredentialPreparationIntent intent,
    String token,
    bool Function() admission,
  ) async {
    _owner(intent, management: true);
    connectorRequire(_admitted(admission));
    final value = await _request(
      () => access.api.postJsonAuthorizedOnce(
        NativePaths.connectorsNativeCredentialPreparationsSubmit,
        authority: _authority(admission),
        data: intent.secretRequest(token),
        headers: {'Idempotency-Key': intent.key},
      ),
    );
    _check();
    final result = await ConnectorCredentialPreparationRead.parse(
      value,
      owner,
      intent: intent,
      kind: 'submit',
    );
    _check();
    return result;
  }

  @override
  Future<ConnectorCredentialPreparationRead> readPreparation(
    ConnectorCredentialPreparationIntent intent,
  ) async {
    _owner(intent);
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.connectorsNativeCredentialPreparationsRead(
          intent.keySha256,
        ),
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await ConnectorCredentialPreparationRead.parse(
      value,
      owner,
      intent: intent,
    );
    _check();
    return result;
  }

  @override
  Future<ConnectorCredentialPreparationRead> abandon(
    ConnectorCredentialPreparationIntent intent,
    bool Function() admission,
  ) async {
    _owner(intent);
    connectorRequire(_admitted(admission));
    final value = await _request(
      () => access.api.postJsonAuthorized(
        NativePaths.connectorsNativeCredentialPreparationsAbandon(
          intent.keySha256,
        ),
        authority: _authority(admission),
        data: intent.abandonRequest,
        headers: {'Idempotency-Key': intent.key},
      ),
    );
    _check();
    final result = await ConnectorCredentialPreparationRead.parse(
      value,
      owner,
      intent: intent,
      kind: 'abandon',
    );
    _check();
    return result;
  }

  @override
  Future<ConnectorCredentialRotationRead> submit(
    ConnectorCredentialRotationIntent intent,
    bool Function() admission,
  ) async {
    _owner(intent.preparation, management: true);
    connectorRequire(intent.key != null && _admitted(admission));
    final value = await _request(
      () => access.api.postJsonAuthorized(
        NativePaths.connectorsNativeCredentialRotationsSubmit,
        authority: _authority(admission),
        data: intent.request,
        headers: {'Idempotency-Key': intent.key},
      ),
    );
    _check();
    final result = await ConnectorCredentialRotationRead.parse(
      value,
      owner,
      intent: intent,
      kind: 'submit',
    );
    _check();
    return result;
  }

  @override
  Future<ConnectorCredentialRotationRead> readAction(
    ConnectorCredentialRotationIntent intent,
  ) async {
    _owner(intent.preparation);
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.connectorsNativeCredentialRotationsRead(intent.keySha256),
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await ConnectorCredentialRotationRead.parse(
      value,
      owner,
      intent: intent,
    );
    _check();
    return result;
  }

  @override
  void close() {
    _open = false;
    _reads.cancel('Credential workspace replaced.');
  }
}
