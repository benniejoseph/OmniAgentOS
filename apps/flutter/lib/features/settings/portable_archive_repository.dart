import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import '../results/created_file_export.dart';
import 'portable_archive_contracts.dart';

abstract interface class PortableArchiveRepository {
  bool get current;
  String get tenantId;
  String get actorId;
  Future<AuthorizedByteResponse> download(CancelToken cancel);
  void Function() observeInvalidation(void Function() listener);
}

/// One explicit asset-free export GET. A failed authority probe permanently
/// invalidates this repository, including a change on the same API object.
class ApiPortableArchiveRepository implements PortableArchiveRepository {
  ApiPortableArchiveRepository(this.access);
  final NativeWorkspaceAccess access;
  bool _disposed = false;
  final Set<CancelToken> _reads = {};
  final Set<void Function()> _listeners = {};
  @override
  String get tenantId => access.authority.tenantId;
  @override
  String get actorId => access.authority.actorId;
  @override
  bool get current {
    if (_disposed) return false;
    try {
      if (!access.current ||
          NativeRequestAuthority.normalizeApiBaseUrl(access.api.apiBaseUrl) !=
              NativeRequestAuthority.normalizeApiBaseUrl(
                access.authority.apiBaseUrl,
              )) {
        dispose();
      }
    } catch (_) {
      dispose();
    }
    return !_disposed;
  }

  @override
  void Function() observeInvalidation(void Function() listener) {
    if (_disposed) {
      listener();
      return () {};
    }
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    for (final listener in _listeners.toList(growable: false)) {
      listener();
    }
    _listeners.clear();
    for (final cancel in _reads) {
      cancel.cancel('Portable archive access changed.');
    }
    _reads.clear();
  }

  @override
  Future<AuthorizedByteResponse> download(CancelToken cancel) async {
    if (!current || cancel.isCancelled) {
      throw const CreatedFileExportScopeChanged();
    }
    if (!NativeContract.supportsOperation('admin.data.export')) {
      throw StateError('Portable archive is unavailable in this app version.');
    }
    _reads.add(cancel);
    try {
      final response = await access.api.getBytesAuthorized(
        NativePaths.adminDataExport,
        authority: access.authority,
        cancelToken: cancel,
        maximumBytes: portableArchiveMaxBytes,
        timeout: const Duration(seconds: 150),
      );
      if (!current || cancel.isCancelled) {
        throw const CreatedFileExportScopeChanged();
      }
      return response;
    } finally {
      _reads.remove(cancel);
    }
  }
}
