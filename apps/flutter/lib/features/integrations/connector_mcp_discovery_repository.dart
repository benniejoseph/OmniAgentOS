import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'connector_contracts.dart';
import 'connector_control_contracts.dart';
import 'connector_mcp_discovery_contracts.dart';

abstract interface class ConnectorMcpDiscoveryRepository {
  ConnectorOwner get owner;
  bool get current;
  Future<ConnectorReview> review(String connectorId);
  Future<ConnectorMcpDiscoveryRead> submit(
    ConnectorMcpDiscoveryIntent intent,
    bool Function() admission,
  );
  Future<ConnectorMcpDiscoveryRead> recover(ConnectorMcpDiscoveryIntent intent);
  Future<ConnectorMcpDiscoveryRead> closeAttempt(
    ConnectorMcpDiscoveryIntent intent,
    bool Function() admission,
  );
  void cancelReads();
  void close();
}

class ApiConnectorMcpDiscoveryRepository
    implements ConnectorMcpDiscoveryRepository {
  ApiConnectorMcpDiscoveryRepository(this.access, {this.isCurrent})
    : owner = ConnectorOwner.fromAccess(access);
  final NativeWorkspaceAccess access;
  final bool Function()? isCurrent;
  @override
  final ConnectorOwner owner;
  CancelToken _reads = CancelToken();
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
  void _check() => connectorRequire(current, 'MCP discovery access changed.');
  void _owner(ConnectorMcpDiscoveryIntent intent, {bool management = false}) {
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
  Future<ConnectorMcpDiscoveryRead> submit(
    ConnectorMcpDiscoveryIntent intent,
    bool Function() admission,
  ) async {
    _owner(intent, management: true);
    connectorRequire(_admitted(admission));
    final value = await _request(
      () => access.api.postJsonAuthorizedOnce(
        NativePaths.connectorsNativeMcpDiscoveriesSubmit,
        authority: _authority(admission),
        data: intent.request,
        headers: {'Idempotency-Key': intent.key},
        receiveTimeout: const Duration(seconds: 55),
      ),
    );
    _check();
    final result = await ConnectorMcpDiscoveryRead.parse(
      value,
      owner,
      intent: intent,
      kind: 'submit',
    );
    _check();
    return result;
  }

  @override
  Future<ConnectorMcpDiscoveryRead> recover(
    ConnectorMcpDiscoveryIntent intent,
  ) async {
    _owner(intent);
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.connectorsNativeMcpDiscoveriesRead(intent.keySha256),
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await ConnectorMcpDiscoveryRead.parse(
      value,
      owner,
      intent: intent,
    );
    _check();
    return result;
  }

  @override
  Future<ConnectorMcpDiscoveryRead> closeAttempt(
    ConnectorMcpDiscoveryIntent intent,
    bool Function() admission,
  ) async {
    _owner(intent);
    connectorRequire(_admitted(admission));
    final value = await _request(
      () => access.api.postJsonAuthorizedOnce(
        NativePaths.connectorsNativeMcpDiscoveriesClose(intent.keySha256),
        authority: _authority(admission),
        data: intent.closeRequest,
        headers: {'Idempotency-Key': intent.key},
      ),
    );
    _check();
    final result = await ConnectorMcpDiscoveryRead.parse(
      value,
      owner,
      intent: intent,
      kind: 'close',
    );
    _check();
    return result;
  }

  @override
  void cancelReads() {
    _reads.cancel('MCP discovery review hidden or replaced.');
    _reads = CancelToken();
  }

  @override
  void close() {
    _open = false;
    _reads.cancel('MCP discovery workspace replaced.');
  }
}
