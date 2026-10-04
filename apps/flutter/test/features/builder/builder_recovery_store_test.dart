import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:asael/features/builder/builder_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'builder_test_support.dart';

void main() {
  late Directory directory;
  late EncryptedBuilderRecoveryStore store;
  final secret = DeviceSecretMaterial(
    id: 'abcdefghijklmnopqrstuvwx',
    bytes: Uint8List.fromList(List.generate(32, (index) => index + 1)),
  );
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('asael-builder-test-');
    store = EncryptedBuilderRecoveryStore(
      () async => secret,
      broker: LocalCiphertextRecoveryBroker.forTesting(() async => directory),
    );
  });
  tearDown(() async {
    await directory.delete(recursive: true);
  });
  Future<List<File>> records() async =>
      (await directory.list(recursive: true).toList())
          .whereType<File>()
          .where((file) => file.path.endsWith('.builder'))
          .toList();

  test(
    'source draft and immutable pending target are encrypted and recoverable',
    () async {
      final data = {
        'draft': 'confidential-source-value',
        'outcome': {
          'state': 'prepared',
          'submitted': {'action': 'stop', 'sessionId': buildId('session')},
        },
      };
      await store.write(
        testBuilderOwner(),
        builderProject,
        data,
        isCurrent: () => true,
      );
      expect(await store.read(testBuilderOwner(), builderProject), data);
      final disk = await (await records()).single.readAsString();
      expect(disk, isNot(contains('confidential-source-value')));
      expect(disk, isNot(contains(buildId('session'))));
      expect(disk, isNot(contains(builderProject)));
      expect(disk, isNot(contains(builderUser)));
    },
  );
  test('canonical owner, actor, tenant, role, API path and exact project isolate recovery', () async {
    await store.write(testBuilderOwner(), builderProject, {
      'draft': 'private',
    }, isCurrent: () => true);
    for (final owner in [
      testBuilderOwner(user: builderOtherUser),
      testBuilderOwner(actor: 'other@example.test'),
      testBuilderOwner(tenant: 'other'),
      testBuilderOwner(role: 'viewer'),
      testBuilderOwner(api: '$builderApi/other'),
    ]) {
      expect(await store.read(owner, builderProject), isNull);
    }
    expect(await store.read(testBuilderOwner(), 'other-project'), isNull);
  });
  test('authenticated ciphertext rejects tampering and preserves errors rather than clearing pending intent', () async {
    await store.write(testBuilderOwner(), builderProject, {
      'outcome': 'uncertain',
    }, isCurrent: () => true);
    final file = (await records()).single;
    final value = jsonDecode(await file.readAsString()) as Map<String, dynamic>;
    final bytes = base64Decode(value['ciphertext'] as String);
    bytes[0] ^= 1;
    value['ciphertext'] = base64Encode(bytes);
    await file.writeAsString(jsonEncode(value));
    await expectLater(
      store.read(testBuilderOwner(), builderProject),
      throwsA(anything),
    );
    expect(await file.exists(), isTrue);
  });
  test(
    'authority lost during protected key lookup prevents any record commit',
    () async {
      final held = Completer<DeviceSecretMaterial>();
      var current = true;
      store = EncryptedBuilderRecoveryStore(
        () => held.future,
        broker: LocalCiphertextRecoveryBroker.forTesting(() async => directory),
      );
      final writing = store.write(testBuilderOwner(), builderProject, {
        'draft': 'private',
      }, isCurrent: () => current);
      final rejected = expectLater(writing, throwsStateError);
      await Future<void>.delayed(Duration.zero);
      current = false;
      held.complete(secret);
      await rejected;
      expect(await records(), isEmpty);
    },
  );
  test('serialized replacement leaves one complete latest record', () async {
    final first = store.write(testBuilderOwner(), builderProject, {
      'draft': 'first',
    }, isCurrent: () => true);
    final second = store.write(testBuilderOwner(), builderProject, {
      'draft': 'second',
    }, isCurrent: () => true);
    await Future.wait([first, second]);
    expect(await store.read(testBuilderOwner(), builderProject), {
      'draft': 'second',
    });
    expect(await records(), hasLength(1));
  });
  test('another Builder window cannot replace a prepared intent from a stale empty read', () async {
    final other = EncryptedBuilderRecoveryStore(
      () async => secret,
      broker: LocalCiphertextRecoveryBroker.forTesting(() async => directory),
    );
    expect(await store.read(testBuilderOwner(), builderProject), isNull);
    expect(await other.read(testBuilderOwner(), builderProject), isNull);
    await store.write(testBuilderOwner(), builderProject, {
      'outcome': 'prepared-original',
    }, isCurrent: () => true);
    await expectLater(
      other.write(testBuilderOwner(), builderProject, {
        'outcome': 'stale',
      }, isCurrent: () => true),
      throwsA(isA<RecoveryStorageChanged>()),
    );
    await expectLater(
      other.write(testBuilderOwner(), builderProject, {
        'outcome': 'stale',
      }, isCurrent: () => true),
      throwsA(isA<RecoveryStorageUnknown>()),
    );
    expect(
      (await other.read(testBuilderOwner(), builderProject))!['outcome'],
      'prepared-original',
    );
  });
}
