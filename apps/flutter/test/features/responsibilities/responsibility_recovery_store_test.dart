import 'dart:io';
import 'dart:convert';
import 'dart:typed_data';

import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:asael/features/responsibilities/responsibility_contracts.dart';
import 'package:asael/features/responsibilities/responsibility_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:cryptography/cryptography.dart';

import 'responsibility_test_support.dart';

class _UnknownCommitBroker implements CiphertextRecoveryBroker {
  _UnknownCommitBroker(this.delegate);
  final CiphertextRecoveryBroker delegate;
  var writes = 0;
  @override
  Future<RecoveryCiphertext> read(RecoveryAddress address) =>
      delegate.read(address);
  @override
  Future<String> compareAndSwap(
    RecoveryAddress address, {
    required String? expectedSha256,
    required String ciphertext,
  }) async {
    final digest = await delegate.compareAndSwap(
      address,
      expectedSha256: expectedSha256,
      ciphertext: ciphertext,
    );
    if (++writes == 1) {
      throw const RecoveryStorageUnknown();
    }
    return digest;
  }
}

void main() {
  late Directory directory;
  late EncryptedResponsibilityRecoveryStore store;
  setUp(() async {
    directory = await Directory.systemTemp.createTemp(
      'responsibility-recovery-',
    );
    store = EncryptedResponsibilityRecoveryStore(
      () async => DeviceSecretMaterial(
        id: 'abcdefghijklmnopqrstuvwx',
        bytes: Uint8List.fromList(List.generate(32, (n) => n)),
      ),
      broker: LocalCiphertextRecoveryBroker.forTesting(() async => directory),
    );
  });
  tearDown(() async {
    await directory.delete(recursive: true);
  });
  test('broker reads and updates the pre-broker encrypted format without migration', () async {
    final binding = responsibilityCanonical([
      'asael-responsibility-recovery:1',
      testOwner.key,
    ]);
    final payload = {'pending': 'legacy-exact-request'};
    final cipher = AesGcm.with256bits();
    final encrypted = await cipher.encrypt(
      utf8.encode(
        jsonEncode({
          'schemaVersion': 1,
          'binding': binding,
          'payload': payload,
        }),
      ),
      secretKey: SecretKey(List.generate(32, (n) => n)),
      nonce: List.filled(12, 0),
      aad: utf8.encode(binding),
    );
    final root = Directory(
      '${directory.path}/asael-responsibility-recovery-v1/abcdefghijklmnopqrstuvwx',
    );
    await root.create(recursive: true);
    await File(
      '${root.path}/${await responsibilityHash(binding)}.responsibility',
    ).writeAsString(
      jsonEncode({
        'version': 1,
        'algorithm': 'aes-256-gcm',
        'nonce': base64Encode(encrypted.nonce),
        'ciphertext': base64Encode(encrypted.cipherText),
        'mac': base64Encode(encrypted.mac.bytes),
      }),
    );
    expect(await store.read(testOwner), payload);
    await store.write(testOwner, {
      'pending': 'next-exact-request',
    }, isCurrent: () => true);
    expect((await store.read(testOwner))!['pending'], 'next-exact-request');
  });
  test(
    'unknown storage commit requires authenticated reload before another save',
    () async {
      final broker = _UnknownCommitBroker(
        LocalCiphertextRecoveryBroker.forTesting(() async => directory),
      );
      store = EncryptedResponsibilityRecoveryStore(
        () async => DeviceSecretMaterial(
          id: 'abcdefghijklmnopqrstuvwx',
          bytes: Uint8List.fromList(List.generate(32, (n) => n)),
        ),
        broker: broker,
      );
      await expectLater(
        store.write(testOwner, {'pending': 'original'}, isCurrent: () => true),
        throwsA(isA<RecoveryStorageUnknown>()),
      );
      await expectLater(
        store.write(testOwner, {
          'pending': 'replacement',
        }, isCurrent: () => true),
        throwsA(isA<RecoveryStorageUnknown>()),
      );
      expect(broker.writes, 1);
      expect((await store.read(testOwner))!['pending'], 'original');
      await store.write(testOwner, {
        'pending': 'reloaded',
      }, isCurrent: () => true);
      expect(broker.writes, 2);
    },
  );
  test(
    'recovery is encrypted and bound to canonical owner, role and deployment',
    () async {
      final payload = {
        'schemaVersion': 1,
        'privateText': 'Never leave owner meeting evidence in plaintext',
      };
      await store.write(testOwner, payload, isCurrent: () => true);
      expect(await store.read(testOwner), payload);
      final files = await directory
          .list(recursive: true)
          .where(
            (item) => item is File && item.path.endsWith('.responsibility'),
          )
          .cast<File>()
          .toList();
      expect(files, hasLength(1));
      expect(await files.single.readAsString(), isNot(contains('Never leave')));
      for (final owner in [
        const ResponsibilityOwner(
          userId: '22222222-2222-4222-8222-222222222222',
          tenantId: 'tenant-a',
          requestActorId: 'owner@example.test',
          role: 'operator',
          apiBaseUrl: 'https://example.test',
        ),
        const ResponsibilityOwner(
          userId: '11111111-1111-4111-8111-111111111111',
          tenantId: 'tenant-a',
          requestActorId: 'owner@example.test',
          role: 'viewer',
          apiBaseUrl: 'https://example.test',
        ),
        const ResponsibilityOwner(
          userId: '11111111-1111-4111-8111-111111111111',
          tenantId: 'tenant-a',
          requestActorId: 'owner@example.test',
          role: 'operator',
          apiBaseUrl: 'https://other.test',
        ),
      ]) {
        expect(await store.read(owner), isNull);
      }
    },
  );
  test(
    'scope loss before write preserves the original exact recovery',
    () async {
      await store.write(testOwner, {
        'pending': 'original-key',
      }, isCurrent: () => true);
      await expectLater(
        store.write(testOwner, {
          'pending': 'replacement-key',
        }, isCurrent: () => false),
        throwsFormatException,
      );
      expect((await store.read(testOwner))!['pending'], 'original-key');
    },
  );
  test('oversized local payload is rejected without pruning earlier unresolved intent', () async {
    await store.write(testOwner, {
      'pending': 'original-key',
    }, isCurrent: () => true);
    await expectLater(
      store.write(testOwner, {
        'text': List.filled(2500001, 'x').join(),
      }, isCurrent: () => true),
      throwsFormatException,
    );
    expect((await store.read(testOwner))!['pending'], 'original-key');
  });
  test(
    'ciphertext corruption cannot become an empty successful recovery',
    () async {
      await store.write(testOwner, {
        'pending': 'original-key',
      }, isCurrent: () => true);
      final file = await directory
          .list(recursive: true)
          .where(
            (item) => item is File && item.path.endsWith('.responsibility'),
          )
          .cast<File>()
          .single;
      await file.writeAsString('{broken encrypted envelope');
      await expectLater(store.read(testOwner), throwsA(isA<FormatException>()));
    },
  );
  test(
    'another window cannot overwrite a pending intent from an older empty read',
    () async {
      final other = EncryptedResponsibilityRecoveryStore(
        () async => DeviceSecretMaterial(
          id: 'abcdefghijklmnopqrstuvwx',
          bytes: Uint8List.fromList(List.generate(32, (n) => n)),
        ),
        broker: LocalCiphertextRecoveryBroker.forTesting(() async => directory),
      );
      expect(await store.read(testOwner), isNull);
      expect(await other.read(testOwner), isNull);
      await store.write(testOwner, {
        'pending': 'first-window-key',
      }, isCurrent: () => true);
      await expectLater(
        other.write(testOwner, {
          'pending': 'second-window-key',
        }, isCurrent: () => true),
        throwsA(isA<ResponsibilityRecoveryChanged>()),
      );
      expect((await other.read(testOwner))!['pending'], 'first-window-key');
    },
  );
}
