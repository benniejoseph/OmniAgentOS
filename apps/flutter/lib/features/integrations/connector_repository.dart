import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'connector_contracts.dart';
import 'connector_control_contracts.dart';

abstract interface class ConnectorRepository {
  ConnectorOwner get owner;
  bool get current;
  Future<ConnectorInventory> list();
  Future<ConnectorReview> review(String kind, String id);
  Future<ConnectorActionRead> submit(
    ConnectorIntent intent,
    bool Function() admission,
  );
  Future<ConnectorActionRead> recover(ConnectorIntent intent);
  void close();
}

class ApiConnectorRepository implements ConnectorRepository {
  ApiConnectorRepository(this.access)
    : owner = ConnectorOwner.fromAccess(access);
  final NativeWorkspaceAccess access;
  @override
  final ConnectorOwner owner;
  final _reads = CancelToken();
  bool _open = true;
  @override
  bool get current {
    if (!_open) {
      return false;
    }
    if (!access.current || !_open) {
      close();
      return false;
    }
    return true;
  }

  NativeRequestAuthority _authority([bool Function()? admission]) =>
      NativeRequestAuthority(
        tenantId: owner.tenantId,
        actorId: owner.actorId,
        canonicalUserId: owner.userId,
        role: owner.role,
        apiBaseUrl: owner.apiBaseUrl,
        isCurrent: () => current && (admission?.call() ?? true) && current,
      );
  void _check() =>
      connectorRequire(current, 'Connector account access changed.');
  Future<T> _request<T>(Future<T> Function() request) async {
    try {
      return await request();
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
  Future<ConnectorInventory> list() async {
    _check();
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.connectorsNativeList,
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await ConnectorInventory.parse(value, owner);
    _check();
    return result;
  }

  @override
  Future<ConnectorReview> review(String kind, String id) async {
    _check();
    controlKind(kind);
    controlId(id);
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.connectorsNativeReview(kind, id),
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await ConnectorReview.parse(value, owner, kind, id);
    _check();
    return result;
  }

  @override
  Future<ConnectorActionRead> submit(
    ConnectorIntent intent,
    bool Function() admission,
  ) async {
    _check();
    connectorRequire(owner.key == intent.owner.key && admission());
    _check();
    final value = await _request(
      () => access.api.postJsonAuthorized(
        NativePaths.connectorsNativeAct,
        authority: _authority(admission),
        data: intent.request,
        headers: {'Idempotency-Key': intent.key},
      ),
    );
    _check();
    final result = await ConnectorActionRead.parse(
      value,
      owner,
      intent.keySha256,
      intent: intent,
      mutation: true,
    );
    _check();
    return result;
  }

  @override
  Future<ConnectorActionRead> recover(ConnectorIntent intent) async {
    _check();
    connectorRequire(
      owner.storageKey == intent.owner.storageKey &&
          connectorSame(owner.scope, intent.owner.scope),
    );
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.connectorsNativeActionsGet(intent.keySha256),
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await ConnectorActionRead.parse(
      value,
      owner,
      intent.keySha256,
      intent: intent,
    );
    _check();
    return result;
  }

  @override
  void close() {
    _open = false;
    _reads.cancel('Connector workspace replaced.');
  }
}
