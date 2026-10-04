import 'dart:async';
import 'dart:io';

import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('test/recovery-storage');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final address = RecoveryAddress(
    RecoveryNamespace.responsibility,
    'abcdefghijklmnopqrstuvwx',
    List.filled(64, 'a').join(),
  );
  const broker = MacOsCiphertextRecoveryBroker(channel: channel);
  tearDown(() {
    messenger.setMockMethodCallHandler(channel, null);
  });

  test('fixed addresses reject paths and unknown key forms', () {
    expect(
      () => RecoveryAddress(
        RecoveryNamespace.builder,
        '../private',
        address.recordKey,
      ),
      throwsFormatException,
    );
    expect(
      () => RecoveryAddress(
        RecoveryNamespace.builder,
        address.secretId,
        '../private',
      ),
      throwsFormatException,
    );
  });
  test(
    'native read checks exact namespace, secret, key and raw UTF8 digest',
    () async {
      const content = '{"ciphertext":"é"}';
      final digest = await recoveryCiphertextHash(content);
      messenger.setMockMethodCallHandler(channel, (call) async {
        expect(call.method, 'read');
        expect(call.arguments, address.json);
        return {
          ...address.json,
          'status': 'read',
          'ciphertext': content,
          'sha256': digest,
        };
      });
      expect((await broker.read(address)).content, content);
      messenger.setMockMethodCallHandler(
        channel,
        (_) async => {
          ...address.json,
          'recordKey': List.filled(64, 'b').join(),
          'status': 'read',
          'ciphertext': content,
          'sha256': digest,
        },
      );
      await expectLater(
        broker.read(address),
        throwsA(isA<RecoveryStorageUnavailable>()),
      );
    },
  );
  test('missing registration and malformed commit are unknown, never local fallback', () async {
    await expectLater(
      broker.compareAndSwap(
        address,
        expectedSha256: null,
        ciphertext: 'encrypted',
      ),
      throwsA(isA<RecoveryStorageUnknown>()),
    );
    messenger.setMockMethodCallHandler(
      channel,
      (_) async => {
        ...address.json,
        'status': 'committed',
        'sha256': List.filled(64, '0').join(),
      },
    );
    await expectLater(
      broker.compareAndSwap(
        address,
        expectedSha256: null,
        ciphertext: 'encrypted',
      ),
      throwsA(isA<RecoveryStorageUnknown>()),
    );
  });
  test(
    'only explicit pre-commit conflict and capacity are definite failures',
    () async {
      for (final pair in [
        ('recovery_conflict', isA<RecoveryStorageChanged>()),
        ('recovery_capacity', isA<RecoveryStorageCapacity>()),
        ('recovery_unknown', isA<RecoveryStorageUnknown>()),
        ('recovery_unavailable', isA<RecoveryStorageUnknown>()),
      ]) {
        messenger.setMockMethodCallHandler(
          channel,
          (_) async => throw PlatformException(code: pair.$1),
        );
        await expectLater(
          broker.compareAndSwap(
            address,
            expectedSha256: null,
            ciphertext: 'encrypted',
          ),
          throwsA(pair.$2),
        );
      }
    },
  );
  test(
    'timeout after commit can be reloaded without repeating a write',
    () async {
      final held = Completer<Object?>();
      String? persisted;
      var writes = 0;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'compareAndSwap') {
          writes++;
          persisted = (call.arguments as Map)['ciphertext'] as String;
          return held.future;
        }
        return {
          ...address.json,
          'status': 'read',
          'ciphertext': persisted,
          'sha256': await recoveryCiphertextHash(persisted!),
        };
      });
      const timed = MacOsCiphertextRecoveryBroker(
        channel: channel,
        timeout: Duration(milliseconds: 10),
      );
      await expectLater(
        timed.compareAndSwap(
          address,
          expectedSha256: null,
          ciphertext: 'exact-encrypted-intent',
        ),
        throwsA(isA<RecoveryStorageUnknown>()),
      );
      expect((await broker.read(address)).content, 'exact-encrypted-intent');
      expect(writes, 1);
      held.complete({
        ...address.json,
        'status': 'committed',
        'sha256': await recoveryCiphertextHash(persisted!),
      });
    },
  );
  test('injected file adapter compares independent writers and preserves prior bytes', () async {
    final directory = await Directory.systemTemp.createTemp(
      'recovery-broker-test-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final first = LocalCiphertextRecoveryBroker.forTesting(
      () async => directory,
    );
    final second = LocalCiphertextRecoveryBroker.forTesting(
      () async => directory,
    );
    expect((await first.read(address)).content, isNull);
    expect((await second.read(address)).content, isNull);
    await first.compareAndSwap(
      address,
      expectedSha256: null,
      ciphertext: 'winner',
    );
    await expectLater(
      second.compareAndSwap(address, expectedSha256: null, ciphertext: 'stale'),
      throwsA(isA<RecoveryStorageChanged>()),
    );
    expect((await second.read(address)).content, 'winner');
  });

  for (final leaf in ['record', 'lock']) {
    test(
      'mobile adapter rejects an observed linked $leaf without reading or writing its target',
      () async {
        final directory = await Directory.systemTemp.createTemp(
          'recovery-linked-node-',
        );
        addTearDown(() => directory.delete(recursive: true));
        final local = LocalCiphertextRecoveryBroker.forTesting(
          () async => directory,
        );
        await local.read(address);
        final root =
            '${directory.path}/${address.namespace.directoryName}/${address.secretId}';
        final outside = File('${directory.path}/outside');
        await outside.writeAsString('protected-original');
        await Link(
          leaf == 'record'
              ? '$root/${address.recordKey}.responsibility'
              : '$root/.transaction.lock',
        ).create(outside.path);
        await expectLater(
          leaf == 'record'
              ? local.read(address)
              : local.compareAndSwap(
                  address,
                  expectedSha256: null,
                  ciphertext: 'replacement',
                ),
          throwsA(isA<RecoveryStorageUnavailable>()),
        );
        expect(await outside.readAsString(), 'protected-original');
      },
    );
  }
}
