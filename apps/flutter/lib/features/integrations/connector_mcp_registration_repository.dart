import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'connector_contracts.dart';
import 'connector_mcp_registration_contracts.dart';

abstract interface class ConnectorMcpRegistrationRepository {
  ConnectorOwner get owner;
  bool get current;
  Future<ConnectorMcpRegistrationPreparationRead> prepare(
    ConnectorMcpRegistrationPreparationIntent intent,
    String endpoint,
    String? token,
    bool Function() admission,
  );
  Future<ConnectorMcpRegistrationPreparationRead> readPreparation(
    ConnectorMcpRegistrationPreparationIntent intent,
  );
  Future<ConnectorMcpRegistrationPreparationRead> abandon(
    ConnectorMcpRegistrationPreparationIntent intent,
    bool Function() admission,
  );
  Future<ConnectorMcpRegistrationRead> submit(
    ConnectorMcpRegistrationIntent intent,
    bool Function() admission,
  );
  Future<ConnectorMcpRegistrationRead> readAction(
    ConnectorMcpRegistrationIntent intent,
  );
  void close();
}

class ApiConnectorMcpRegistrationRepository
    implements ConnectorMcpRegistrationRepository {
  ApiConnectorMcpRegistrationRepository(this.access, {this.isCurrent})
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
      connectorRequire(current, 'Registration recovery access changed.');
  void _owner(
    ConnectorMcpRegistrationPreparationIntent intent, {
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
  Future<ConnectorMcpRegistrationPreparationRead> prepare(
    ConnectorMcpRegistrationPreparationIntent intent,
    String endpoint,
    String? token,
    bool Function() admission,
  ) async {
    _owner(intent, management: true);
    connectorRequire(_admitted(admission));
    final value = await _request(
      () => access.api.postJsonAuthorizedOnce(
        NativePaths.connectorsNativeMcpRegistrationPreparationsSubmit,
        authority: _authority(admission),
        data: intent.secretRequest(endpoint, token),
        headers: {'Idempotency-Key': intent.key},
      ),
    );
    _check();
    final result = await ConnectorMcpRegistrationPreparationRead.parse(
      value,
      owner,
      intent: intent,
      kind: 'submit',
    );
    _check();
    return result;
  }

  @override
  Future<ConnectorMcpRegistrationPreparationRead> readPreparation(
    ConnectorMcpRegistrationPreparationIntent intent,
  ) async {
    _owner(intent);
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.connectorsNativeMcpRegistrationPreparationsRead(
          intent.keySha256,
        ),
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await ConnectorMcpRegistrationPreparationRead.parse(
      value,
      owner,
      intent: intent,
    );
    _check();
    return result;
  }

  @override
  Future<ConnectorMcpRegistrationPreparationRead> abandon(
    ConnectorMcpRegistrationPreparationIntent intent,
    bool Function() admission,
  ) async {
    _owner(intent);
    connectorRequire(_admitted(admission));
    final value = await _request(
      () => access.api.postJsonAuthorized(
        NativePaths.connectorsNativeMcpRegistrationPreparationsAbandon(
          intent.keySha256,
        ),
        authority: _authority(admission),
        data: intent.abandonRequest,
        headers: {'Idempotency-Key': intent.key},
      ),
    );
    _check();
    final result = await ConnectorMcpRegistrationPreparationRead.parse(
      value,
      owner,
      intent: intent,
      kind: 'abandon',
    );
    _check();
    return result;
  }

  @override
  Future<ConnectorMcpRegistrationRead> submit(
    ConnectorMcpRegistrationIntent intent,
    bool Function() admission,
  ) async {
    _owner(intent.preparation, management: true);
    connectorRequire(intent.key != null && _admitted(admission));
    final value = await _request(
      () => access.api.postJsonAuthorized(
        NativePaths.connectorsNativeMcpRegistrationsSubmit,
        authority: _authority(admission),
        data: intent.request,
        headers: {'Idempotency-Key': intent.key},
      ),
    );
    _check();
    final result = await ConnectorMcpRegistrationRead.parse(
      value,
      owner,
      intent: intent,
      kind: 'submit',
    );
    _check();
    return result;
  }

  @override
  Future<ConnectorMcpRegistrationRead> readAction(
    ConnectorMcpRegistrationIntent intent,
  ) async {
    _owner(intent.preparation);
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.connectorsNativeMcpRegistrationsRead(intent.keySha256),
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await ConnectorMcpRegistrationRead.parse(
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
    _reads.cancel('Registration workspace replaced.');
  }
}
