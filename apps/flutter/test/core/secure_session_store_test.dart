import 'package:asael/core/auth/biometric_gate.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test('macOS release always uses the frozen credential broker', () {
    final storage = createAsaelSecureStorage(
      platform: TargetPlatform.macOS,
      isWeb: false,
      isDebugMode: false,
    );
    expect(storage, isA<MacOsCredentialBrokerStore>());
  });

  test('macOS debug retains the explicit flutter-run adapter', () {
    final storage = createAsaelSecureStorage(
      platform: TargetPlatform.macOS,
      isWeb: false,
      isDebugMode: true,
    );
    expect(storage, isA<MacOsFileKeychainStore>());
    final options = (storage as MacOsFileKeychainStore).channelOptions;
    expect(
      options['accountName'],
      'app.omniagent.omniagent.debug-file-keychain.v1',
    );
    expect(options['usesDataProtectionKeychain'], 'false');
    expect(options, isNot(contains('groupId')));
  });

  test('broker probe reports migration without reading a secret', () async {
    const channel = MethodChannel('test/secure-storage');
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return {
            'state': 'migration_required',
            'migrationRequired': true,
            'legacyItemCount': 7,
          };
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );
    final store = MacOsCredentialBrokerStore(channel: channel);

    await expectLater(
      store.prepare(),
      throwsA(
        isA<SecureStoreMigrationRequiredException>().having(
          (error) => error.legacyItemCount,
          'legacy count',
          7,
        ),
      ),
    );
    expect(calls, hasLength(1));
    expect(calls.single.method, 'probe');
    expect(calls.single.arguments, isNull);
  });

  test('broker forwards only the requested key/value operation', () async {
    const channel = MethodChannel('test/secure-storage-write');
    MethodCall? observed;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          observed = call;
          return <String, Object?>{};
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );
    final store = MacOsCredentialBrokerStore(channel: channel);

    await store.write(key: 'asael.session_token', value: 'secret-value');
    expect(observed?.method, 'write');
    expect(observed?.arguments, {
      'key': 'asael.session_token',
      'value': 'secret-value',
    });
  });

  test('broker migration conflict is exposed as a typed safe state', () async {
    const channel = MethodChannel('test/secure-storage-conflict');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          channel,
          (_) => throw PlatformException(
            code: 'secure_store_migration_conflict',
            message: 'native details that must not escape',
          ),
        );
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );

    await expectLater(
      MacOsCredentialBrokerStore(channel: channel).migrateLegacyCredentials(),
      throwsA(
        isA<SecureStoreMigrationConflictException>().having(
          (error) => error.toString(),
          'safe message',
          isNot(contains('native details')),
        ),
      ),
    );
  });

  test('other native platforms retain their default secure-storage policy', () {
    final storage = createAsaelSecureStorage(
      platform: TargetPlatform.android,
      isWeb: false,
    );
    expect(storage, isA<FlutterSecureValueStore>());
    final options =
        (storage as FlutterSecureValueStore).storage.mOptions as MacOsOptions;

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
