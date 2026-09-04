import 'dart:convert';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SecureSessionStore {
  const SecureSessionStore(this._storage);
  static const _tokenKey = 'asael.session_token';
  static const _refreshTokenKey = 'asael.refresh_token';
  static const _accessExpiresAtKey = 'asael.access_expires_at';
  static const _deviceIdKey = 'asael.device_id';
  static const _legacyTokenKey = 'omniagent.session_token';
  final FlutterSecureStorage _storage;

  Future<String?> readToken() async {
    final token = await _storage.read(key: _tokenKey);
    if (token != null) return token;
    final legacyToken = await _storage.read(key: _legacyTokenKey);
    if (legacyToken == null) return null;
    await _storage.write(key: _tokenKey, value: legacyToken);
    await _storage.delete(key: _legacyTokenKey);
    return legacyToken;
  }

  Future<void> writeToken(String token) async {
    await _storage.write(key: _tokenKey, value: token);
    await _storage.delete(key: _legacyTokenKey);
  }

  Future<String?> readRefreshToken() =>
      _storage.read(key: _refreshTokenKey);

  Future<void> writeTokens({
    required String accessToken,
    required String refreshToken,
    required String accessExpiresAt,
  }) async {
    // Store the new refresh credential first and publish its matching access
    // token last. A crash cannot expose the new access token with an old
    // refresh token.
    await _storage.write(key: _refreshTokenKey, value: refreshToken);
    await _storage.write(key: _accessExpiresAtKey, value: accessExpiresAt);
    await _storage.write(key: _tokenKey, value: accessToken);
    await _storage.delete(key: _legacyTokenKey);
  }

  Future<bool> accessTokenNeedsRefresh({
    Duration leeway = const Duration(seconds: 30),
  }) async {
    final value = await _storage.read(key: _accessExpiresAtKey);
    if (value == null) return false;
    final expiresAt = DateTime.tryParse(value)?.toUtc();
    if (expiresAt == null) return true;
    return !expiresAt.isAfter(DateTime.now().toUtc().add(leeway));
  }

  Future<String> readOrCreateDeviceId() async {
    final existing = await _storage.read(key: _deviceIdKey);
    if (existing != null && existing.isNotEmpty) return existing;
    final random = Random.secure();
    final bytes = List<int>.generate(24, (_) => random.nextInt(256));
    final created = 'asael-${base64UrlEncode(bytes).replaceAll('=', '')}';
    await _storage.write(key: _deviceIdKey, value: created);
    return created;
  }

  Future<void> clear() async {
    await _storage.delete(key: _tokenKey);
    await _storage.delete(key: _refreshTokenKey);
    await _storage.delete(key: _accessExpiresAtKey);
    await _storage.delete(key: _legacyTokenKey);
  }
}

final secureSessionStoreProvider = Provider<SecureSessionStore>(
  (_) => const SecureSessionStore(FlutterSecureStorage()),
);
