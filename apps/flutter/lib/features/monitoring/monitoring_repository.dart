import 'package:dio/dio.dart';

import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'monitoring_contracts.dart';

abstract interface class MonitoringRepository {
  bool get current;
  bool get canReadPrivate;
  Future<MonitoringHealth> health(CancelToken cancel);
  Future<MonitoringSloSnapshot> slo(CancelToken cancel);
  Future<MonitoringIncidents> incidents(CancelToken cancel);
  Future<MonitoringAlerts> alerts(CancelToken cancel);
  Future<MonitoringTimeline> timeline(CancelToken cancel);
}

/// Five GETs, each fenced by the same exact live session and deployment.
class ApiMonitoringRepository implements MonitoringRepository {
  ApiMonitoringRepository(this.access);
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
      cancel.cancel('Monitoring access changed.');
    }
    _reads.clear();
  }

  Future<Map<String, dynamic>> _read(
    String operation,
    String path,
    CancelToken cancel, {
    bool public = false,
  }) async {
    if (!current || cancel.isCancelled) {
      throw StateError('Monitoring access changed.');
    }
    if (!public && !canReadPrivate) {
      throw const ApiException('Monitoring is restricted.', statusCode: 403);
    }
    if (!NativeContract.supportsOperation(operation)) {
      throw StateError('Monitoring is unavailable in this app version.');
    }
    _reads.add(cancel);
    try {
      final response = await access.api.getJsonAuthorized(
        path,
        authority: access.authority,
        cancelToken: cancel,
      );
      if (!current || cancel.isCancelled) {
        throw StateError('Monitoring access changed.');
      }
      return response;
    } finally {
      _reads.remove(cancel);
    }
  }

  @override
  Future<MonitoringHealth> health(CancelToken cancel) async {
    try {
      return MonitoringHealth.parse(
        await _read(
          'admin.health',
          NativePaths.adminHealth,
          cancel,
          public: true,
        ),
      );
    } on ApiException catch (error) {
      if (!current || cancel.isCancelled) {
        throw StateError('Monitoring access changed.');
      }
      if (error.statusCode != 503 || error.responseData == null) rethrow;
      final evidence = MonitoringHealth.parse(error.responseData!);
      if (evidence.status != MonitoringHealthStatus.unhealthy) {
        throw const FormatException(
          'Health response contradicts its HTTP status.',
        );
      }
      return evidence;
    }
  }

  @override
  Future<MonitoringSloSnapshot> slo(CancelToken cancel) async =>
      MonitoringSloSnapshot.parse(
        await _read('admin.slo', NativePaths.adminSlo, cancel),
        tenantId: access.authority.tenantId,
      );
  @override
  Future<MonitoringIncidents> incidents(CancelToken cancel) async =>
      MonitoringIncidents.parse(
        await _read('admin.incidents', NativePaths.adminIncidents, cancel),
        tenantId: access.authority.tenantId,
      );
  @override
  Future<MonitoringAlerts> alerts(CancelToken cancel) async =>
      MonitoringAlerts.parse(
        await _read('admin.alerts', NativePaths.adminAlerts, cancel),
        tenantId: access.authority.tenantId,
      );
  @override
  Future<MonitoringTimeline> timeline(CancelToken cancel) async =>
      MonitoringTimeline.parse(
        await _read(
          'admin.observability',
          NativePaths.adminObservability,
          cancel,
        ),
        tenantId: access.authority.tenantId,
      );
}
