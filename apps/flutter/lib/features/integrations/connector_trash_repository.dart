import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'connector_contracts.dart';
import 'connector_control_contracts.dart';
import 'connector_trash_contracts.dart';

abstract interface class ConnectorTrashRepository {
  ConnectorOwner get owner;
  bool get current;
  Future<ConnectorReview> review(String connectorId);
  Future<ConnectorTrashPreview> preview(String connectorId);
  Future<ConnectorTrashRead> submit(
    ConnectorTrashIntent intent,
    bool Function() admission,
  );
  Future<ConnectorTrashRead> recover(
    String keySha256, {
    required ConnectorTrashIntent intent,
  });
  void close();
}

class ApiConnectorTrashRepository implements ConnectorTrashRepository {
  ApiConnectorTrashRepository(this.access, {this.isCurrent})
    : owner = ConnectorOwner.fromAccess(access);

  final NativeWorkspaceAccess access;
  final bool Function()? isCurrent;
  @override
  final ConnectorOwner owner;
  final _reads = CancelToken();
  bool _open = true;

  @override
  bool get current {
    if (!_open) return false;
    if (!(isCurrent?.call() ?? true) || !_open) {
      close();
      return false;
    }
    final allowed = access.current;
    // An authority probe can synchronously dispose the outgoing provider.
    if (!_open || !allowed || !(isCurrent?.call() ?? true) || !_open) {
      close();
      return false;
    }
    return true;
  }

  bool _admitted(bool Function()? admission) {
    if (!current || !(admission?.call() ?? true)) return false;
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

  void _check() => connectorRequire(current, 'Connector Trash access changed.');

  Future<T> _request<T>(Future<T> Function() operation) async {
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
  Future<ConnectorReview> review(String connectorId) async {
    _check();
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.connectorsNativeReview('mcp', controlId(connectorId)),
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await ConnectorReview.parse(
      value,
      owner,
      'mcp',
      connectorId,
    );
    _check();
    return result;
  }

  @override
  Future<ConnectorTrashPreview> preview(String connectorId) async {
    _check();
    connectorRequire(const ['admin', 'system'].contains(owner.role));
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.connectorsNativeTrashPreview(controlId(connectorId)),
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await ConnectorTrashPreview.parse(value, owner, connectorId);
    _check();
    return result;
  }

  @override
  Future<ConnectorTrashRead> submit(
    ConnectorTrashIntent intent,
    bool Function() admission,
  ) async {
    connectorRequire(
      owner.key == intent.owner.key &&
          const ['admin', 'system'].contains(owner.role) &&
          _admitted(admission),
    );
    final value = await _request(
      () => access.api.postJsonAuthorized(
        NativePaths.connectorsNativeTrashSubmit,
        authority: _authority(admission),
        data: intent.request,
        headers: {'Idempotency-Key': intent.key},
      ),
    );
    _check();
    final result = await ConnectorTrashRead.parse(
      value,
      owner,
      kind: 'submit',
      keySha256: intent.keySha256,
      intent: intent,
    );
    _check();
    return result;
  }

  @override
  Future<ConnectorTrashRead> recover(
    String keySha256, {
    required ConnectorTrashIntent intent,
  }) async {
    _check();
    connectorHash(keySha256);
    connectorRequire(
      owner.storageKey == intent.owner.storageKey &&
          connectorSame(owner.scope, intent.owner.scope) &&
          keySha256 == intent.keySha256,
    );
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.connectorsNativeTrashRead(keySha256),
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await ConnectorTrashRead.parse(
      value,
      owner,
      kind: 'read',
      keySha256: keySha256,
      intent: intent,
    );
    _check();
    return result;
  }

  @override
  void close() {
    _open = false;
    _reads.cancel('Connector Trash workspace replaced.');
  }
}
