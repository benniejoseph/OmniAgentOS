import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter/services.dart';

import '../auth/biometric_gate.dart';

class SecureSessionStore {
  SecureSessionStore(FlutterSecureStorage storage)
    : this.withStorage(FlutterSecureValueStore(storage));

  SecureSessionStore.withStorage(this._storage);
  static const _operationTimeout = Duration(seconds: 20);
  static const _migrationTimeout = Duration(minutes: 3);
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
  static const pendingPushReceiptRecordKeyPrefix =
      'asael.pending_push_receipt_v1.';
  static const _legacyTokenKey = 'omniagent.session_token';
  final AsaelSecureValueStore _storage;
  bool _biometricReleaseUnlocked = false;

  /// Performs only a non-interactive readiness probe. On macOS this never
  /// reads legacy secret bytes; an old store is surfaced as an explicit
  /// migration state for the bootstrap UI.
  Future<void> prepare() => _bounded(_storage.prepare());

  Future<void> migrateLegacyCredentials() =>
      _storage.migrateLegacyCredentials().timeout(
        _migrationTimeout,
        onTimeout: () => throw const SecureStoreUnavailableException(
          'Credential migration did not finish. Your original session is still safe.',
        ),
      );

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

  bool get supportsPendingPushReceiptRecords =>
      _storage is AsaelEnumerableSecureValueStore;

  Future<Map<String, String>> readAllPendingPushReceiptRecords() async {
    final storage = _storage;
    if (storage is! AsaelEnumerableSecureValueStore) {
      throw UnsupportedError(
        'This secure store cannot enumerate push receipt records.',
      );
    }
    final values = await _bounded(storage.readAll());
    return Map.unmodifiable(
      Map.fromEntries(
        values.entries.where(
          (entry) => entry.key.startsWith(pendingPushReceiptRecordKeyPrefix),
        ),
      ),
    );
  }

  Future<String?> readPendingPushReceiptRecord(String key) {
    _validatePendingPushReceiptRecordKey(key);
    return _read(key);
  }

  Future<void> writePendingPushReceiptRecord(String key, String value) {
    _validatePendingPushReceiptRecordKey(key);
    return _write(key, value);
  }

  Future<void> clearPendingPushReceiptRecord(String key) {
    _validatePendingPushReceiptRecordKey(key);
    return _delete(key);
  }

  void _validatePendingPushReceiptRecordKey(String key) {
    final suffix = key.startsWith(pendingPushReceiptRecordKeyPrefix)
        ? key.substring(pendingPushReceiptRecordKeyPrefix.length)
        : '';
    if (!RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(suffix)) {
      throw ArgumentError.value(key, 'key', 'Invalid push receipt record key.');
    }
  }

  Future<void> _clearPendingPushReceiptRecords() async {
    if (!supportsPendingPushReceiptRecords) return;
    final records = await readAllPendingPushReceiptRecords();
    await Future.wait(records.keys.map(clearPendingPushReceiptRecord));
  }

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
      _clearPendingPushReceiptRecords(),
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
      _clearPendingPushReceiptRecords(),
    ]);
    _biometricReleaseUnlocked = false;
  }
}

abstract interface class AsaelSecureValueStore {
  Future<void> prepare();

  Future<void> migrateLegacyCredentials();

  Future<String?> read({required String key});

  Future<void> write({required String key, required String value});

  Future<void> delete({required String key});
}

abstract interface class AsaelEnumerableSecureValueStore
    implements AsaelSecureValueStore {
  Future<Map<String, String>> readAll();
}

class FlutterSecureValueStore implements AsaelEnumerableSecureValueStore {
  const FlutterSecureValueStore(this.storage);

  final FlutterSecureStorage storage;

  @override
  Future<void> prepare() async {}

  @override
  Future<void> migrateLegacyCredentials() async {}

  @override
  Future<String?> read({required String key}) => storage.read(key: key);

  @override
  Future<void> write({required String key, required String value}) =>
      storage.write(key: key, value: value);

  @override
  Future<void> delete({required String key}) => storage.delete(key: key);

  @override
  Future<Map<String, String>> readAll() => storage.readAll();
}

/// Debug-only adapter for ordinary `flutter run`, whose Xcode product does not
/// embed the separately provisioned release broker.
///
/// This is never selected in a release build. Owner-private releases must fail
/// closed if the frozen broker is missing rather than silently returning to an
/// app-CDHash-owned Keychain item.
class MacOsFileKeychainStore implements AsaelSecureValueStore {
  const MacOsFileKeychainStore({
    this.channel = const MethodChannel(_channelName),
  });

  static const _channelName = 'plugins.it_nomads.com/flutter_secure_storage';
  static const _serviceName = 'app.omniagent.omniagent.debug-file-keychain.v1';
  final MethodChannel channel;

  @visibleForTesting
  Map<String, String> get channelOptions => const {
    'accountName': _serviceName,
    'usesDataProtectionKeychain': 'false',
  };

  Map<String, Object> _arguments(String key, [String? value]) => {
    'key': key,
    'value': ?value,
    'options': channelOptions,
  };

  @override
  Future<void> prepare() async {}

  @override
  Future<void> migrateLegacyCredentials() async {}

  @override
  Future<String?> read({required String key}) =>
      channel.invokeMethod<String>('read', _arguments(key));

  @override
  Future<void> write({required String key, required String value}) =>
      channel.invokeMethod<void>('write', _arguments(key, value));

  @override
  Future<void> delete({required String key}) =>
      channel.invokeMethod<void>('delete', _arguments(key));
}

/// Talks to Asael's frozen, separately signed macOS credential broker.
///
/// Private self-signed app releases receive a new CodeDirectory hash on every
/// build. Keeping Keychain calls in a versioned helper lets the Keychain ACL
/// retain one stable identity across host-app updates. The helper is a direct
/// child with an allowlisted protocol and never receives process credentials.
class MacOsCredentialBrokerStore implements AsaelSecureValueStore {
  const MacOsCredentialBrokerStore({
    this.channel = const MethodChannel(_channelName),
  });

  static const _channelName = 'app.omniagent.omniagent/secure-storage';
  final MethodChannel channel;

  @override
  Future<void> prepare() async {
    final response = await _invokeMap('probe');
    if (response['migrationRequired'] == true) {
      final count = response['legacyItemCount'];
      throw SecureStoreMigrationRequiredException(
        legacyItemCount: count is int ? count : null,
      );
    }
  }

  @override
  Future<void> migrateLegacyCredentials() => _invokeVoid('migrate');

  @override
  Future<String?> read({required String key}) async {
    final response = await _invokeMap('read', {'key': key});
    final value = response['value'];
    if (value == null) return null;
    if (value is! String) {
      throw const SecureStoreUnavailableException(
        'The credential broker returned an invalid response.',
      );
    }
    return value;
  }

  @override
  Future<void> write({required String key, required String value}) =>
      _invokeVoid('write', {'key': key, 'value': value});

  @override
  Future<void> delete({required String key}) =>
      _invokeVoid('delete', {'key': key});

  Future<void> _invokeVoid(
    String method, [
    Map<String, Object>? arguments,
  ]) async {
    await _invokeMap(method, arguments);
  }

  Future<Map<Object?, Object?>> _invokeMap(
    String method, [
    Map<String, Object>? arguments,
  ]) async {
    try {
      final response = await channel.invokeMethod<Map<Object?, Object?>>(
        method,
        arguments,
      );
      if (response == null) {
        throw const SecureStoreUnavailableException(
          'The credential broker returned no response.',
        );
      }
      return response;
    } on PlatformException catch (error) {
      switch (error.code) {
        case 'secure_store_migration_required':
          throw const SecureStoreMigrationRequiredException();
        case 'secure_store_migration_conflict':
          throw const SecureStoreMigrationConflictException();
        case 'secure_store_legacy_unknown_keys':
        case 'secure_store_target_unknown_keys':
          throw const SecureStoreMigrationSafetyException();
        default:
          throw const SecureStoreUnavailableException(
            'Asael could not reach the protected credential store. Reopen the app and try again.',
          );
      }
    } on MissingPluginException {
      throw const SecureStoreUnavailableException(
        'This Asael build does not include its protected credential broker.',
      );
    }
  }
}

sealed class SecureStoreException implements Exception {
  const SecureStoreException(this.message);
  final String message;

  @override
  String toString() => message;
}

class SecureStoreMigrationRequiredException extends SecureStoreException {
  const SecureStoreMigrationRequiredException({this.legacyItemCount})
    : super(
        'A one-time credential upgrade is required. Your existing session will remain intact until the upgrade is verified.',
      );
  final int? legacyItemCount;
}

class SecureStoreMigrationConflictException extends SecureStoreException {
  const SecureStoreMigrationConflictException()
    : super(
        'The old and new credential stores do not match. Nothing was deleted; sign out or contact support before continuing.',
      );
}

class SecureStoreMigrationSafetyException extends SecureStoreException {
  const SecureStoreMigrationSafetyException()
    : super(
        'Unexpected Keychain entries were found. Asael left every existing item unchanged.',
      );
}

class SecureStoreUnavailableException extends SecureStoreException {
  const SecureStoreUnavailableException(super.message);
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
AsaelSecureValueStore createAsaelSecureStorage({
  TargetPlatform? platform,
  bool? isWeb,
  bool? isDebugMode,
}) {
  final usesMacOSKeychain =
      !(isWeb ?? kIsWeb) &&
      (platform ?? defaultTargetPlatform) == TargetPlatform.macOS;
  if (!usesMacOSKeychain) {
    return const FlutterSecureValueStore(FlutterSecureStorage());
  }

  if (isDebugMode ?? kDebugMode) {
    return const MacOsFileKeychainStore();
  }

  // Credentials remain device-bound and are not shared with an extension. The
  // separately signed broker owns only Asael's compile-time Keychain allowlist;
  // the Share Extension must continue using its reviewed intake handoff.
  return const MacOsCredentialBrokerStore();
}

final secureSessionStoreProvider = Provider<SecureSessionStore>(
  (_) => SecureSessionStore.withStorage(createAsaelSecureStorage()),
);
