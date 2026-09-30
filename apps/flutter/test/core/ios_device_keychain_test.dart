import 'dart:convert';

import 'package:asael/core/storage/secure_session_store.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const _channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
const _legacyService = 'flutter_secure_storage_service';
const _deviceService = 'app.omniagent.omniagent.device-keychain.v1';
const _deviceOnly = 'first_unlock_this_device';
const _tokenKey = 'asael.session_token';
const _deviceIdKey = 'asael.device_id';
const _ownerKey = 'asael.offline_projection_owner_v1';
const _pushIdKey = 'asael.push_registration_id_v1';
final _receiptKey =
    '${SecureSessionStore.pendingPushReceiptRecordKeyPrefix}${'r' * 43}';
final _owner = jsonEncode({
  'version': 1,
  'tenantId': 'tenant-1',
  'actorId': 'actor-1',
});

/// Keeps items the way the iOS Keychain does: under their service, and found
/// only by a query for the accessibility they were written with. While
/// [locked], items that open only when the device is unlocked can be neither
/// read nor written; before the first unlock nothing can.
class _Keychain {
  final services = <String, Map<String, ({String value, String access})>>{};
  final calls = <(String, String, String?)>[];
  final failingWrites = <String>{};
  bool locked = false;
  bool unlockedSinceRestart = true;

  void seed(
    String service,
    Map<String, String> values, {
    String access = 'unlocked',
  }) => services.putIfAbsent(service, () => {}).addAll({
    for (final MapEntry(:key, :value) in values.entries)
      key: (value: value, access: access),
  });

  Map<String, String> values(String service) => {
    for (final MapEntry(:key, :value) in (services[service] ?? {}).entries)
      key: value.value,
  };

  Set<String> access(String service) => {
    for (final item in (services[service] ?? {}).values) item.access,
  };

  int movesStarted() =>
      calls.where((call) => call == ('readAll', _legacyService, null)).length;

  Future<Object?> handle(MethodCall call) async {
    final arguments = call.arguments as Map;
    final options = Map<String, String>.from(arguments['options'] as Map);
    final service = options['accountName'] ?? '';
    final access = options['accessibility'] ?? '';
    final key = arguments['key'] as String?;
    calls.add((call.method, service, key));
    if (!unlockedSinceRestart || (locked && access == 'unlocked')) {
      throw PlatformException(code: '-25308', message: 'Not allowed.');
    }
    final items = services.putIfAbsent(service, () => {});
    final found = {
      for (final MapEntry(:key, :value) in items.entries)
        if (value.access == access) key: value.value,
    };
    switch (call.method) {
      case 'read':
        return found[key];
      case 'readAll':
        return found;
      case 'containsKey':
        return found.containsKey(key);
      case 'write':
        if (failingWrites.remove(key)) {
          throw PlatformException(code: '-25295', message: 'Write failed.');
        }
        if (items.containsKey(key) && !found.containsKey(key)) {
          throw PlatformException(code: '-25299', message: 'Duplicate item.');
        }
        items[key!] = (value: arguments['value'] as String, access: access);
        return null;
      case 'delete':
        items.remove(key);
        return null;
      case 'deleteAll':
        items.clear();
        return null;
    }
    throw MissingPluginException(call.method);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Keychain keychain;

  setUp(() {
    keychain = _Keychain();
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, keychain.handle);
  });

  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, null);
  });

  AsaelSecureValueStore appStorage() =>
      createAsaelSecureStorage(platform: TargetPlatform.iOS, isWeb: false);

  SecureSessionStore app() => SecureSessionStore.withStorage(appStorage());

  Map<String, String> moved() =>
      keychain.values(_deviceService)..remove('asael.keychain_moved_v1');

  test(
    'moves every item to this device once and deletes the old ones',
    () async {
      final legacy = {
        _tokenKey: 'access-1',
        'asael.refresh_token': 'refresh-1',
        _deviceIdKey: 'device-1',
        _ownerKey: _owner,
        _receiptKey: 'receipt-1',
        'omniagent.session_token': 'access-0',
      };
      keychain.seed(_legacyService, legacy);
      final store = app();

      final (_, token, deviceId) = await (
        store.prepare(),
        store.readTokenForRemoteWipe(),
        store.readExistingDeviceId(),
      ).wait;

      expect((token, deviceId), ('access-1', 'device-1'));
      expect(keychain.movesStarted(), 1);
      expect(moved(), legacy);
      expect(keychain.access(_deviceService), {_deviceOnly});
      expect(keychain.values(_legacyService), isEmpty);
      expect(await store.readAllPendingPushReceiptRecords(), {
        _receiptKey: 'receipt-1',
      });

      await app().prepare();
      expect(keychain.movesStarted(), 1);
      expect(moved(), legacy);
    },
  );

  test('reads its items while the device is locked once they moved', () async {
    keychain.seed(_legacyService, {_ownerKey: _owner});
    await app().prepare();
    keychain.locked = true;

    final background = createBackgroundSecureSessionStore();
    expect(await background.readOfflineProjectionOwner(), (
      tenantId: 'tenant-1',
      actorId: 'actor-1',
    ));
    await background.writePendingPushReceiptRecord(_receiptKey, 'receipt-1');
    expect(await background.readAllPendingPushReceiptRecords(), {
      _receiptKey: 'receipt-1',
    });
  });

  test('a launch while locked keeps the old items for the next one', () async {
    keychain
      ..seed(_legacyService, {_tokenKey: 'access-1'})
      ..locked = true;
    final first = app();

    await first.prepare();
    await expectLater(
      first.readTokenForRemoteWipe(),
      throwsA(isA<PlatformException>()),
    );
    keychain.locked = false;
    await first.writePushRegistrationId('push-1');

    expect(keychain.values(_legacyService), {
      _tokenKey: 'access-1',
      _pushIdKey: 'push-1',
    });
    expect(keychain.values(_deviceService), isEmpty);

    final next = app();
    await next.prepare();
    expect(await next.readPushRegistrationId(), 'push-1');
    expect(await next.readTokenForRemoteWipe(), 'access-1');
    expect(keychain.values(_legacyService), isEmpty);
  });

  test('a launch before the first unlock fails and then moves', () async {
    keychain
      ..seed(_legacyService, {_tokenKey: 'access-1'})
      ..unlockedSinceRestart = false;
    final store = app();

    await expectLater(store.prepare(), throwsA(isA<PlatformException>()));
    keychain.unlockedSinceRestart = true;
    await store.prepare();

    expect(moved(), {_tokenKey: 'access-1'});
    expect(keychain.values(_legacyService), isEmpty);
  });

  test('a move cut short starts over from the old items', () async {
    // A move that stopped before its mark left stale copies behind.
    keychain
      ..seed(_legacyService, {_tokenKey: 'access-2', _deviceIdKey: 'device-1'})
      ..seed(_deviceService, {
        _tokenKey: 'access-1',
        'asael.refresh_token': 'refresh-1',
      }, access: _deviceOnly)
      ..failingWrites.add(_deviceIdKey);

    await app().prepare();
    expect(keychain.values(_legacyService), {
      _tokenKey: 'access-2',
      _deviceIdKey: 'device-1',
    });

    final store = app();
    await store.prepare();
    expect(moved(), {_tokenKey: 'access-2', _deviceIdKey: 'device-1'});
    expect(await store.readExistingDeviceId(), 'device-1');
    expect(keychain.values(_legacyService), isEmpty);

    // A move that stopped after its mark left the old items behind.
    keychain.seed(_legacyService, {_tokenKey: 'access-1'});
    await app().prepare();
    expect(moved(), {_tokenKey: 'access-2', _deviceIdKey: 'device-1'});
    expect(keychain.values(_legacyService), isEmpty);
  });

  test(
    'a background store reads the old items until the app moves them',
    () async {
      keychain.seed(_legacyService, {_pushIdKey: 'push-1'});
      final background = createBackgroundSecureSessionStore();

      expect(await background.readPushRegistrationId(), 'push-1');
      expect(keychain.values(_deviceService), isEmpty);
      expect(keychain.values(_legacyService), {_pushIdKey: 'push-1'});

      final store = app();
      await store.prepare();
      await store.writePushRegistrationId('push-2');
      expect(await background.readPushRegistrationId(), 'push-2');
    },
  );

  test('lists the stored items without its own mark', () async {
    keychain.seed(_legacyService, {_tokenKey: 'access-1'});
    final storage = appStorage() as AsaelEnumerableSecureValueStore;

    expect(await storage.readAll(), {_tokenKey: 'access-1'});
    expect(keychain.values(_deviceService), hasLength(2));
  });

  test('other platforms keep the plugin store as it is', () async {
    expect(
      createAsaelSecureStorage(platform: TargetPlatform.iOS, isWeb: true),
      isA<FlutterSecureValueStore>(),
    );
    debugDefaultTargetPlatformOverride = TargetPlatform.android;

    expect(
      await createBackgroundSecureSessionStore().readPushRegistrationId(),
      isNull,
    );
    expect(keychain.calls.map((call) => (call.$1, call.$3)), [
      ('read', _pushIdKey),
    ]);
  });
}
