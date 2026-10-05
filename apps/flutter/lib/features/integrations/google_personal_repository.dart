import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'connector_contracts.dart';
import 'google_personal_contracts.dart';

abstract interface class GooglePersonalRepository {
  ConnectorOwner get owner;
  bool get current;
  Future<GooglePersonalRead> review();
  Future<GooglePersonalRead> submit(
    GooglePersonalIntent intent,
    bool Function() admission,
  );
  Future<GooglePersonalRead> recover(
    String keySha256, {
    GooglePersonalIntent? intent,
  });
  void close();
}

class ApiGooglePersonalRepository implements GooglePersonalRepository {
  ApiGooglePersonalRepository(this.access, {this.isCurrent})
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

  void _check() => connectorRequire(current, 'Google account access changed.');

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
  Future<GooglePersonalRead> review() async {
    _check();
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.googlePersonalActionsReview,
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await GooglePersonalRead.parse(value, owner);
    _check();
    return result;
  }

  @override
  Future<GooglePersonalRead> submit(
    GooglePersonalIntent intent,
    bool Function() admission,
  ) async {
    connectorRequire(
      owner.key == intent.owner.key &&
          const ['operator', 'admin', 'system'].contains(owner.role) &&
          _admitted(admission),
    );
    final value = await _request(
      () => access.api.postJsonAuthorized(
        NativePaths.googlePersonalActionsSubmit,
        authority: _authority(admission),
        data: intent.request,
        headers: {'Idempotency-Key': intent.key},
      ),
    );
    _check();
    final result = await GooglePersonalRead.parse(
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
  Future<GooglePersonalRead> recover(
    String keySha256, {
    GooglePersonalIntent? intent,
  }) async {
    _check();
    connectorHash(keySha256);
    if (intent != null) {
      connectorRequire(
        owner.storageKey == intent.owner.storageKey &&
            connectorSame(owner.scope, intent.owner.scope) &&
            keySha256 == intent.keySha256,
      );
    }
    final value = await _request(
      () => access.api.getJsonAuthorized(
        NativePaths.googlePersonalActionsRead(keySha256),
        authority: _authority(),
        cancelToken: _reads,
      ),
    );
    _check();
    final result = await GooglePersonalRead.parse(
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
    _reads.cancel('Google workspace replaced.');
  }
}
