import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../auth/biometric_gate.dart';

class SecureSessionStore {
  SecureSessionStore(this._storage);
  static const _operationTimeout = Duration(seconds: 20);
  static const _tokenKey = 'asael.session_token';
  static const _refreshTokenKey = 'asael.refresh_token';
  static const _accessExpiresAtKey = 'asael.access_expires_at';
  static const _deviceIdKey = 'asael.device_id';
  static const _biometricEnabledKey = 'asael.biometric_enabled';
  static const _captureOutboxSecretKey = 'asael.capture_outbox_secret_v1';
  static const _offlineProjectionSecretKey =
      'asael.offline_projection_secret_v1';
  static const _offlineProjectionOwnerKey = 'asael.offline_projection_owner_v1';
  static const _pushRegistrationIdKey = 'asael.push_registration_id_v1';
  static const _pushPreviewPolicyKey = 'asael.push_preview_policy_v1';
  static const _pendingPushAcknowledgementKey =
      'asael.pending_push_acknowledgement_v1';
  static const _legacyTokenKey = 'omniagent.session_token';
  final FlutterSecureStorage _storage;
  bool _biometricReleaseUnlocked = false;

  Future<T> _bounded<T>(Future<T> operation) => operation.timeout(
    _operationTimeout,
    onTimeout: () => throw StateError(
      'The operating system secure store did not respond. Reopen Asael and try again.',
    ),
  );

  Future<String?> _read(String key) => _bounded(_storage.read(key: key));

  Future<void> _write(String key, String value) =>
      _bounded(_storage.write(key: key, value: value));

  Future<void> _delete(String key) => _bounded(_storage.delete(key: key));

  Future<String?> readToken() async {
    await _requireBiometricRelease();
    return _readTokenWithoutRelease();
  }

  Future<String?> readTokenForRemoteWipe() => _readTokenWithoutRelease();

  Future<String?> _readTokenWithoutRelease() async {
    final token = await _read(_tokenKey);
    if (token != null) return token;
    final legacyToken = await _read(_legacyTokenKey);
    if (legacyToken == null) return null;
    await _write(_tokenKey, legacyToken);
    await _delete(_legacyTokenKey);
    return legacyToken;
  }

  Future<void> writeToken(String token) async {
    await _write(_tokenKey, token);
    await _delete(_legacyTokenKey);
  }

  Future<String?> readRefreshToken() async {
    await _requireBiometricRelease();
    return _read(_refreshTokenKey);
  }

  Future<bool> hasStoredCredentials() async {
    return await _read(_tokenKey) != null ||
        await _read(_refreshTokenKey) != null ||
        await _read(_legacyTokenKey) != null;
  }

  Future<void> writeTokens({
    required String accessToken,
    required String refreshToken,
    required String accessExpiresAt,
  }) async {
    // Store the new refresh credential first and publish its matching access
    // token last. A crash cannot expose the new access token with an old
    // refresh token.
    await _write(_refreshTokenKey, refreshToken);
    await _write(_accessExpiresAtKey, accessExpiresAt);
    await _write(_tokenKey, accessToken);
    await _delete(_legacyTokenKey);
    _biometricReleaseUnlocked = true;
  }

  Future<bool> accessTokenNeedsRefresh({
    Duration leeway = const Duration(seconds: 30),
  }) async {
    final value = await _read(_accessExpiresAtKey);
    if (value == null) return false;
    final expiresAt = DateTime.tryParse(value)?.toUtc();
    if (expiresAt == null) return true;
    return !expiresAt.isAfter(DateTime.now().toUtc().add(leeway));
  }

  Future<String> readOrCreateDeviceId() async {
    final existing = await _read(_deviceIdKey);
    if (existing != null && existing.isNotEmpty) return existing;
    final random = Random.secure();
    final bytes = List<int>.generate(24, (_) => random.nextInt(256));
    final created = 'asael-${base64UrlEncode(bytes).replaceAll('=', '')}';
    await _write(_deviceIdKey, created);
    return created;
  }

  Future<String?> readExistingDeviceId() => _read(_deviceIdKey);

  Future<String?> readPushRegistrationId() => _read(_pushRegistrationIdKey);

  Future<void> writePushRegistrationId(String value) =>
      _write(_pushRegistrationIdKey, value);

  Future<void> clearPushRegistrationId() => _delete(_pushRegistrationIdKey);

  Future<String> readPushPreviewPolicy() async {
    final value = await _read(_pushPreviewPolicyKey);
    return const {'hidden', 'generic', 'title'}.contains(value)
        ? value!
        : 'hidden';
  }

  Future<void> writePushPreviewPolicy(String value) async {
    if (!const {'hidden', 'generic', 'title'}.contains(value)) {
      throw ArgumentError.value(value, 'value', 'Unknown push preview policy.');
    }
    await _write(_pushPreviewPolicyKey, value);
  }

  Future<String?> readPendingPushAcknowledgement() =>
      _read(_pendingPushAcknowledgementKey);

  Future<void> writePendingPushAcknowledgement(String value) =>
      _write(_pendingPushAcknowledgementKey, value);

  Future<void> clearPendingPushAcknowledgement() =>
      _delete(_pendingPushAcknowledgementKey);

  Future<DeviceSecretMaterial> readOrCreateCaptureOutboxSecret() =>
      _readOrCreateDeviceSecret(_captureOutboxSecretKey);

  Future<DeviceSecretMaterial> readOrCreateOfflineProjectionSecret() =>
      _readOrCreateDeviceSecret(_offlineProjectionSecretKey);

  Future<void> writeOfflineProjectionOwner({
    required String tenantId,
    required String actorId,
  }) async {
    if (tenantId.trim().isEmpty ||
        tenantId.length > 200 ||
        actorId.trim().isEmpty ||
        actorId.length > 320) {
      throw const FormatException('The offline projection owner is invalid.');
    }
    await _write(
      _offlineProjectionOwnerKey,
      jsonEncode({'version': 1, 'tenantId': tenantId, 'actorId': actorId}),
    );
  }

  Future<({String tenantId, String actorId})?>
  readOfflineProjectionOwner() async {
    final encoded = await _read(_offlineProjectionOwnerKey);
    if (encoded == null) return null;
    try {
      final value = jsonDecode(encoded);
      if (value is! Map ||
          value['version'] != 1 ||
          value['tenantId'] is! String ||
          value['actorId'] is! String) {
        return null;
      }
      final tenantId = value['tenantId'] as String;
      final actorId = value['actorId'] as String;
      if (tenantId.trim().isEmpty ||
          tenantId.length > 200 ||
          actorId.trim().isEmpty ||
          actorId.length > 320) {
        return null;
      }
      return (tenantId: tenantId, actorId: actorId);
    } catch (_) {
      return null;
    }
  }

  Future<DeviceSecretMaterial> _readOrCreateDeviceSecret(String key) async {
    await _requireBiometricRelease();
    final encoded = await _read(key);
    if (encoded != null) return DeviceSecretMaterial.decode(encoded);
    final random = Random.secure();
    final idBytes = List<int>.generate(18, (_) => random.nextInt(256));
    final keyBytes = List<int>.generate(32, (_) => random.nextInt(256));
    final material = DeviceSecretMaterial(
      id: base64UrlEncode(idBytes).replaceAll('=', ''),
      bytes: Uint8List.fromList(keyBytes),
    );
    await _write(key, material.encode());
    return material;
  }

  Future<bool> readBiometricEnabled() async =>
      await _read(_biometricEnabledKey) == 'true';

  Future<void> setBiometricEnabled(bool enabled) async {
    if (enabled) {
      await _write(_biometricEnabledKey, 'true');
      _biometricReleaseUnlocked = true;
    } else {
      await _delete(_biometricEnabledKey);
      _biometricReleaseUnlocked = true;
    }
  }

  void unlockBiometricRelease() => _biometricReleaseUnlocked = true;

  void lockBiometricRelease() => _biometricReleaseUnlocked = false;

  Future<void> _requireBiometricRelease() async {
    if (_biometricReleaseUnlocked || !await readBiometricEnabled()) return;
    throw const BiometricGateException(BiometricGateFailure.notRecognized);
  }

  Future<void> clear() async {
    await Future.wait([
      _delete(_tokenKey),
      _delete(_refreshTokenKey),
      _delete(_accessExpiresAtKey),
      _delete(_legacyTokenKey),
      _delete(_pushRegistrationIdKey),
      _delete(_pendingPushAcknowledgementKey),
    ]);
    _biometricReleaseUnlocked = false;
  }

  Future<void> clearForRemoteWipe() async {
    await Future.wait([
      _delete(_tokenKey),
      _delete(_refreshTokenKey),
      _delete(_accessExpiresAtKey),
      _delete(_legacyTokenKey),
      _delete(_deviceIdKey),
      _delete(_biometricEnabledKey),
      _delete(_captureOutboxSecretKey),
      _delete(_offlineProjectionSecretKey),
      _delete(_offlineProjectionOwnerKey),
      _delete(_pushRegistrationIdKey),
      _delete(_pushPreviewPolicyKey),
      _delete(_pendingPushAcknowledgementKey),
    ]);
    _biometricReleaseUnlocked = false;
  }
}

class DeviceSecretMaterial {
  const DeviceSecretMaterial({required this.id, required this.bytes});

  factory DeviceSecretMaterial.decode(String encoded) {
    Object? value;
    try {
      value = jsonDecode(encoded);
    } catch (_) {
      throw const FormatException('The device secret is unreadable.');
    }
    if (value is! Map ||
        value['version'] != 1 ||
        value['id'] is! String ||
        value['key'] is! String) {
      throw const FormatException('The device secret is invalid.');
    }
    final id = value['id'] as String;
    Uint8List bytes;
    try {
      bytes = Uint8List.fromList(_decodeBase64Url(value['key'] as String));
    } catch (_) {
      throw const FormatException('The device secret key is invalid.');
    }
    if (!RegExp(r'^[A-Za-z0-9_-]{24}$').hasMatch(id) || bytes.length != 32) {
      throw const FormatException('The device secret key is invalid.');
    }
    return DeviceSecretMaterial(id: id, bytes: bytes);
  }

  final String id;
  final Uint8List bytes;

  String encode() => jsonEncode({
    'version': 1,
    'id': id,
    'key': base64UrlEncode(bytes).replaceAll('=', ''),
  });
}

List<int> _decodeBase64Url(String value) {
  final padding = (4 - value.length % 4) % 4;
  return base64Url.decode(value.padRight(value.length + padding, '='));
}

@visibleForTesting
FlutterSecureStorage createAsaelSecureStorage({
  TargetPlatform? platform,
  bool? isWeb,
}) {
  final usesMacOSKeychain =
      !(isWeb ?? kIsWeb) &&
      (platform ?? defaultTargetPlatform) == TargetPlatform.macOS;
  if (!usesMacOSKeychain) return const FlutterSecureStorage();

  // Asael does not share credentials with another application or extension.
  // The ordinary device-bound macOS Keychain keeps the same OS-backed secret
  // storage without requiring a provisioning-only Keychain Sharing group. A
  // future Share Extension must introduce its own reviewed handoff rather than
  // silently widening this credential boundary.
  return const FlutterSecureStorage(
    mOptions: MacOsOptions(
      accountName: 'app.omniagent.omniagent.secure-store.v1',
      // kSecAttrAccessible selects the data-protection Keychain on macOS.
      // Leave it unset when using the ordinary login Keychain.
      accessibility: null,
      synchronizable: false,
      usesDataProtectionKeychain: false,
    ),
  );
}

final secureSessionStoreProvider = Provider<SecureSessionStore>(
  (_) => SecureSessionStore(createAsaelSecureStorage()),
);
