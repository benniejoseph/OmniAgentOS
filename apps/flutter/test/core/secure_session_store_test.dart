import 'package:asael/core/auth/biometric_gate.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test('macOS uses a device-bound Keychain policy without sharing', () {
    final storage = createAsaelSecureStorage(
      platform: TargetPlatform.macOS,
      isWeb: false,
    );
    final options = storage.mOptions as MacOsOptions;

    expect(options.usesDataProtectionKeychain, isFalse);
    expect(options.groupId, isNull);
    expect(options.accountName, 'app.omniagent.omniagent.secure-store.v1');
    expect(options.synchronizable, isFalse);
    expect(options.accessibility, isNull);
  });

  test('other native platforms retain their default secure-storage policy', () {
    final storage = createAsaelSecureStorage(
      platform: TargetPlatform.android,
      isWeb: false,
    );
    final options = storage.mOptions as MacOsOptions;

    expect(options.usesDataProtectionKeychain, isTrue);
  });

  test(
    'biometric preference prevents credential release while locked',
    () async {
      final store = SecureSessionStore(const FlutterSecureStorage());
      await store.writeTokens(
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        accessExpiresAt: DateTime.now()
            .add(const Duration(minutes: 5))
            .toUtc()
            .toIso8601String(),
      );
      await store.setBiometricEnabled(true);
      store.lockBiometricRelease();

      await expectLater(
        store.readToken(),
        throwsA(isA<BiometricGateException>()),
      );
      await expectLater(
        store.readRefreshToken(),
        throwsA(isA<BiometricGateException>()),
      );
      expect(await store.readTokenForRemoteWipe(), 'access-token');

      store.unlockBiometricRelease();
      expect(await store.readToken(), 'access-token');
      expect(await store.readRefreshToken(), 'refresh-token');
    },
  );

  test(
    'logout preserves installation security while remote wipe erases it',
    () async {
      final store = SecureSessionStore(const FlutterSecureStorage());
      final deviceId = await store.readOrCreateDeviceId();
      await store.setBiometricEnabled(true);
      await store.writePushRegistrationId('registration-one');
      await store.writePushPreviewPolicy('generic');
      await store.writePendingPushAcknowledgement('pending-one');
      await store.writeTokens(
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        accessExpiresAt: DateTime.now()
            .add(const Duration(minutes: 5))
            .toUtc()
            .toIso8601String(),
      );

      await store.clear();
      expect(await store.hasStoredCredentials(), isFalse);
      expect(await store.readExistingDeviceId(), deviceId);
      expect(await store.readBiometricEnabled(), isTrue);
      expect(await store.readPushRegistrationId(), isNull);
      expect(await store.readPushPreviewPolicy(), 'generic');
      expect(await store.readPendingPushAcknowledgement(), isNull);

      await store.writeTokens(
        accessToken: 'replacement-access',
        refreshToken: 'replacement-refresh',
        accessExpiresAt: DateTime.now()
            .add(const Duration(minutes: 5))
            .toUtc()
            .toIso8601String(),
      );
      await store.clearForRemoteWipe();
      expect(await store.hasStoredCredentials(), isFalse);
      expect(await store.readExistingDeviceId(), isNull);
      expect(await store.readBiometricEnabled(), isFalse);
      expect(await store.readPushPreviewPolicy(), 'hidden');
    },
  );

  test(
    'capture outbox secret survives logout and rotates after wipe',
    () async {
      final store = SecureSessionStore(const FlutterSecureStorage());
      final first = await store.readOrCreateCaptureOutboxSecret();
      expect(first.bytes, hasLength(32));

      await store.clear();
      final afterLogout = await store.readOrCreateCaptureOutboxSecret();
      expect(afterLogout.id, first.id);
      expect(afterLogout.bytes, first.bytes);

      await store.clearForRemoteWipe();
      final afterWipe = await store.readOrCreateCaptureOutboxSecret();
      expect(afterWipe.id, isNot(first.id));
      expect(afterWipe.bytes, isNot(first.bytes));
    },
  );
}
