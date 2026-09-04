import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/native_client_info.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/storage/secure_session_store.dart';
import '../domain/app_session.dart';

class SessionRepository {
  const SessionRepository(this._api, this._store);
  final ApiClient _api;
  final SecureSessionStore _store;

  Future<AppSession?> restore() async {
    final accessToken = await _store.readToken();
    final refreshToken = await _store.readRefreshToken();
    if (accessToken == null && refreshToken == null) return null;
    if (accessToken != null) {
      try {
        return AppSession.fromJson(
          await _api.getJson('/api/mobile/bootstrap'),
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
      return AppSession.fromJson(
        await _api.getJson('/api/mobile/bootstrap'),
      );
    } on ApiException catch (error) {
      if (error.statusCode != 401) rethrow;
      await _store.clear();
      return null;
    }
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
    return AppSession.fromJson(json);
  }

  Future<void> signOut() async {
    try {
      await _api.postJson('/api/mobile/auth/logout');
    } finally {
      // A network outage cannot leave this installation appearing signed in.
      // Server-side revocation is still attempted first and the refresh family
      // remains bounded by its expiry when the service is unreachable.
      await _store.clear();
    }
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
        '/api/mobile/auth/login',
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
        '/api/mobile/auth/login',
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
        '/api/mobile/auth/refresh',
        data: {
          'refreshToken': refreshToken,
          'deviceId': deviceId,
          'client': NativeClientInfo.attestation(),
        },
      );
    } on ApiException catch (error) {
      if (error.statusCode != 400) rethrow;
      return _api.postJson(
        '/api/mobile/auth/refresh',
        data: {
          'refreshToken': refreshToken,
          'deviceId': deviceId,
        },
      );
    }
  }

}

final sessionRepositoryProvider = Provider<SessionRepository>(
  (ref) => SessionRepository(
    ref.watch(apiClientProvider),
    ref.watch(secureSessionStoreProvider),
  ),
);
