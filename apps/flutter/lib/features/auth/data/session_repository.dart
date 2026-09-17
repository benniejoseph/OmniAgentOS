import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/native_client_info.dart';
import '../../../core/auth/biometric_gate.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/storage/secure_session_store.dart';
import '../../../generated/native_contract.g.dart';
import '../domain/app_session.dart';

class SessionRepository {
  const SessionRepository(this._api, this._store, this._biometricGate);
  final ApiClient _api;
  final SecureSessionStore _store;
  final BiometricGate _biometricGate;

  Future<AppSession?> restore() async {
    await _store.prepare();
    if (!await _store.hasStoredCredentials()) return null;
    if (await _api.clearAndAcknowledgeRemoteWipe()) return null;
    await unlockBiometricRelease();
    final accessToken = await _store.readToken();
    final refreshToken = await _store.readRefreshToken();
    if (accessToken == null && refreshToken == null) return null;
    if (accessToken != null) {
      try {
        return await _bindOfflineProjectionOwner(
          AppSession.fromJson(await _api.getJson(NativePaths.bootstrapGet)),
        );
      } on ApiException catch (error) {
        if (error.statusCode != 401) rethrow;
      }
    }
    if (refreshToken == null) {
      await _store.clear();
      return null;
    }

    try {
      final deviceId = await _store.readOrCreateDeviceId();
      final rotated = await _refreshWithRollbackFallback(
        refreshToken: refreshToken,
        deviceId: deviceId,
      );
      await _persistTokens(rotated);
      return await _bindOfflineProjectionOwner(
        AppSession.fromJson(await _api.getJson(NativePaths.bootstrapGet)),
      );
    } on ApiException catch (error) {
      if (error.statusCode != 401) rethrow;
      await _store.clear();
      return null;
    }
  }

  Future<AppSession?> migrateLegacyCredentials() async {
    await _store.migrateLegacyCredentials();
    return restore();
  }

  Future<AppSession> signIn({
    required String email,
    required String password,
  }) async {
    final deviceId = await _store.readOrCreateDeviceId();
    final json = await _signInWithRollbackFallback(
      email: email.trim(),
      password: password,
      deviceId: deviceId,
    );
    await _persistTokens(json);
    final session = await _bindOfflineProjectionOwner(
      AppSession.fromJson(json),
    );
    await _api.seedOfflineProjection(NativePaths.bootstrapGet, json);
    return session;
  }

  Future<void> signOut() async {
    try {
      final registrationId = await _store.readPushRegistrationId();
      if (registrationId != null) {
        try {
          await _api.deleteJson(
            NativePaths.pushRegistrationsRevoke(registrationId),
            headers: {'idempotency-key': 'push-revoke-$registrationId'},
          );
        } catch (_) {
          // The authoritative logout below revokes every registration bound
          // to this native session even if the focused unregister call fails.
        }
      }
      await _api.postJson(NativePaths.authLogout);
    } finally {
      // A network outage cannot leave this installation appearing signed in.
      // Server-side revocation is still attempted first and the refresh family
      // remains bounded by its expiry when the service is unreachable.
      await _store.clear();
    }
  }

  Future<bool> isBiometricEnabled() => _store.readBiometricEnabled();

  Future<bool> isBiometricAvailable() => _biometricGate.isAvailable();

  Future<void> setBiometricEnabled(bool enabled) async {
    if (enabled || await _store.readBiometricEnabled()) {
      await _biometricGate.authenticate();
    }
    await _store.setBiometricEnabled(enabled);
  }

  Future<void> unlockBiometricRelease() async {
    if (!await _store.readBiometricEnabled()) {
      _store.unlockBiometricRelease();
      return;
    }
    await _biometricGate.authenticate();
    _store.unlockBiometricRelease();
  }

  Future<bool> lockBiometricRelease() async {
    if (!await _store.readBiometricEnabled()) return false;
    _store.lockBiometricRelease();
    return true;
  }

  Future<AppSession> _bindOfflineProjectionOwner(AppSession session) async {
    await _store.writeOfflineProjectionOwner(
      tenantId: session.tenantId,
      actorId: session.actorId,
    );
    return session;
  }

  Future<void> _persistTokens(Map<String, dynamic> response) async {
    final value = response['tokens'];
    if (value is! Map) {
      throw StateError('The service did not issue native session tokens.');
    }
    final tokens = Map<String, dynamic>.from(value);
    final accessToken = tokens['accessToken']?.toString();
    final refreshToken = tokens['refreshToken']?.toString();
    final accessExpiresAt = tokens['accessExpiresAt']?.toString();
    if (accessToken == null ||
        accessToken.isEmpty ||
        refreshToken == null ||
        refreshToken.isEmpty ||
        accessExpiresAt == null ||
        DateTime.tryParse(accessExpiresAt) == null) {
      throw StateError('The service issued an incomplete native session.');
    }
    await _store.writeTokens(
      accessToken: accessToken,
      refreshToken: refreshToken,
      accessExpiresAt: accessExpiresAt,
    );
  }

  Future<Map<String, dynamic>> _signInWithRollbackFallback({
    required String email,
    required String password,
    required String deviceId,
  }) async {
    try {
      return await _api.postJson(
        NativePaths.authLogin,
        data: {
          'email': email,
          'password': password,
          'device': {
            ...NativeClientInfo.legacyDevice(deviceId),
            ...NativeClientInfo.attestation(),
          },
        },
      );
    } on ApiException catch (error) {
      // The immediately previous server release used strict schemas that did
      // not know build/contract fields. A 400 retries only its legacy wire
      // shape; credentials and tenant identity are never changed or inferred.
      if (error.statusCode != 400) rethrow;
      return _api.postJson(
        NativePaths.authLogin,
        data: {
          'email': email,
          'password': password,
          'device': NativeClientInfo.legacyDevice(deviceId),
        },
      );
    }
  }

  Future<Map<String, dynamic>> _refreshWithRollbackFallback({
    required String refreshToken,
    required String deviceId,
  }) async {
    try {
      return await _api.postJson(
        NativePaths.authRefresh,
        data: {
          'refreshToken': refreshToken,
          'deviceId': deviceId,
          'client': NativeClientInfo.attestation(),
        },
      );
    } on ApiException catch (error) {
      if (error.statusCode != 400) rethrow;
      return _api.postJson(
        NativePaths.authRefresh,
        data: {'refreshToken': refreshToken, 'deviceId': deviceId},
      );
    }
  }
}

final sessionRepositoryProvider = Provider<SessionRepository>(
  (ref) => SessionRepository(
    ref.watch(apiClientProvider),
    ref.watch(secureSessionStoreProvider),
    ref.watch(biometricGateProvider),
  ),
);
