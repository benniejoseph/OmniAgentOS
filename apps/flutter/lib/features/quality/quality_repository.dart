import 'package:dio/dio.dart';

import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'quality_contracts.dart';

abstract interface class QualityRepository {
  bool get current;
  bool get canReadRelease;
  Future<QualityEvaluationsSnapshot> evaluations(CancelToken cancel);
  Future<QualityReleaseReport> release(CancelToken cancel);
}

/// Two authorized reads. This projection never receives mutation authority.
class ApiQualityRepository implements QualityRepository {
  ApiQualityRepository(this.access);
  final NativeWorkspaceAccess access;
  bool _disposed = false;
  final Set<CancelToken> _reads = {};
  final Set<void Function()> _invalidationListeners = {};

  @override
  bool get current =>
      !_disposed && access.canManage && access.current && !_disposed;
  @override
  bool get canReadRelease =>
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
      cancel.cancel('Quality access changed.');
    }
    _reads.clear();
  }

  Future<Map<String, dynamic>> _read(
    String operation,
    String path,
    CancelToken cancel,
  ) async {
    if (!current || cancel.isCancelled) {
      throw StateError('Quality access changed.');
    }
    if (!NativeContract.supportsOperation(operation)) {
      throw StateError('Quality is unavailable in this app version.');
    }
    _reads.add(cancel);
    try {
      final response = await access.api.getJsonAuthorized(
        path,
        authority: access.authority,
        cancelToken: cancel,
      );
      if (!current || cancel.isCancelled) {
        throw StateError('Quality access changed.');
      }
      return response;
    } finally {
      _reads.remove(cancel);
    }
  }

  @override
  Future<QualityEvaluationsSnapshot> evaluations(CancelToken cancel) async =>
      QualityEvaluationsSnapshot.parse(
        await _read('evaluations.list', NativePaths.evaluationsList, cancel),
        tenantId: access.authority.tenantId,
      );

  @override
  Future<QualityReleaseReport> release(CancelToken cancel) async {
    if (!current || cancel.isCancelled) {
      throw StateError('Quality access changed.');
    }
    if (!canReadRelease) {
      throw const ApiException(
        'Release evidence is restricted.',
        statusCode: 403,
      );
    }
    return QualityReleaseReport.parse(
      await _read(
        'admin.release.evidence',
        NativePaths.adminReleaseEvidence,
        cancel,
      ),
      tenantId: access.authority.tenantId,
    );
  }
}
