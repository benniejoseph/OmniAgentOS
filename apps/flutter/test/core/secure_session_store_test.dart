import 'package:asael/core/auth/biometric_gate.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

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
    },
  );
}
