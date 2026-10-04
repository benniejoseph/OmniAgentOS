import 'package:dio/dio.dart';

import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'security_contracts.dart';

abstract interface class SecurityRepository {
  bool get current;
  bool get canReadPrivate;
  Future<SecurityAccessContext> context(CancelToken cancel);
  Future<SecurityAudits> audits(CancelToken cancel);
  Future<SecurityIsolation> isolation(CancelToken cancel);
  Future<SecurityRetention> retention(CancelToken cancel);
}

class ApiSecurityRepository implements SecurityRepository {
  ApiSecurityRepository(this.access);
  final NativeWorkspaceAccess access;
  bool _disposed = false;
  final Set<CancelToken> _reads = {};
  final Set<void Function()> _invalidationListeners = {};
  @override
  bool get current {
    if (_disposed) return false;
    if (!access.canManage || !access.current) dispose();
    return !_disposed;
  }

  @override
  bool get canReadPrivate =>
      {'admin', 'system'}.contains(access.authority.role);

  void Function() observeInvalidation(void Function() listener) {
    if (_disposed) {
      listener();
      return () {};
    }
    _invalidationListeners.add(listener);
    return () => _invalidationListeners.remove(listener);
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    for (final listener in _invalidationListeners.toList(growable: false)) {
      listener();
    }
    _invalidationListeners.clear();
    for (final cancel in _reads) {
      cancel.cancel('Security access changed.');
    }
    _reads.clear();
  }

  Future<Map<String, dynamic>> _read(
    String operation,
    String path,
    CancelToken cancel, {
    bool accessContext = false,
  }) async {
    if (!current || cancel.isCancelled) {
      throw StateError('Security access changed.');
    }
    if (!accessContext && !canReadPrivate) {
      throw const ApiException('Security is restricted.', statusCode: 403);
    }
    if (!NativeContract.supportsOperation(operation)) {
      throw StateError('Security is unavailable in this app version.');
    }
    _reads.add(cancel);
    try {
      final response = await access.api.getJsonAuthorized(
        path,
        authority: access.authority,
        cancelToken: cancel,
      );
      if (!current || cancel.isCancelled) {
        throw StateError('Security access changed.');
      }
      return response;
    } finally {
      _reads.remove(cancel);
    }
  }

  @override
  Future<SecurityAccessContext> context(CancelToken cancel) async =>
      SecurityAccessContext.parse(
        await _read(
          'admin.security.context',
          NativePaths.adminSecurityContext,
          cancel,
          accessContext: true,
        ),
        tenantId: access.authority.tenantId,
        actorId: access.authority.actorId,
        userId: access.authority.canonicalUserId,
        role: access.authority.role,
      );
  @override
  Future<SecurityAudits> audits(CancelToken cancel) async =>
      SecurityAudits.parse(
        await _read(
          'admin.security.audits',
          NativePaths.adminSecurityAudits,
          cancel,
        ),
        tenantId: access.authority.tenantId,
      );
  @override
  Future<SecurityIsolation> isolation(CancelToken cancel) async =>
      SecurityIsolation.parse(
        await _read(
          'admin.security.isolation',
          NativePaths.adminSecurityIsolation,
          cancel,
        ),
        tenantId: access.authority.tenantId,
      );
  @override
  Future<SecurityRetention> retention(CancelToken cancel) async =>
      SecurityRetention.parse(
        await _read(
          'admin.security.retention',
          NativePaths.adminSecurityRetention,
          cancel,
        ),
      );
}
