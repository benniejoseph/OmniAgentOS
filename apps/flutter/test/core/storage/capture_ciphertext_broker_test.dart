import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:asael/core/storage/capture_ciphertext_broker.dart';
import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('test/capture-storage');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final address = CaptureStorageAddress(
    'abcdefghijklmnopqrstuvwx',
    'zyxwvutsrqponmlkjihgfedc',
  );
  const broker = MacOsCaptureCiphertextBroker(channel: channel);
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test(
    'fixed capture identities reject paths, suffixes and newline aliases',
    () {
      for (final id in [
        '../foreign',
        '${address.entryId}\n',
        '${address.entryId}.capture',
      ]) {
        expect(
          () => CaptureStorageAddress(address.secretId, id),
          throwsFormatException,
        );
      }
    },
  );

  test('native read binds exact identity and raw ciphertext hash', () async {
    final content = _envelope(address.entryId);
    final hash = await recoveryCiphertextHash(content);
    messenger.setMockMethodCallHandler(channel, (call) async {
      expect(call.method, 'readCapture');
      expect(call.arguments, address.json);
      return {
        ...address.json,
        'status': 'read',
        'ciphertext': content,
        'sha256': hash,
      };
    });
    expect((await broker.read(address)).content, content);
    messenger.setMockMethodCallHandler(
      channel,
      (_) async => {
        ...address.json,
        'entryId': address.secretId,
        'status': 'read',
        'ciphertext': content,
        'sha256': hash,
      },
    );
    await expectLater(
      broker.read(address),
      throwsA(isA<RecoveryStorageUnavailable>()),
    );
  });

  test(
    'an append timeout after commit is readable without another append',
    () async {
      final held = Completer<Object?>();
      final content = _envelope(address.entryId);
      var appends = 0;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'appendCapture') {
          appends++;
          return held.future;
        }
        return {
          ...address.json,
          'status': 'read',
          'ciphertext': content,
          'sha256': await recoveryCiphertextHash(content),
        };
      });
      const timed = MacOsCaptureCiphertextBroker(
        channel: channel,
        timeout: Duration(milliseconds: 10),
      );
      await expectLater(
        timed.append(address, content),
        throwsA(isA<RecoveryStorageUnknown>()),
      );
      expect((await broker.read(address)).content, content);
      expect(appends, 1);
      held.complete({
        ...address.json,
        'status': 'appended',
        'sha256': await recoveryCiphertextHash(content),
      });
    },
  );

  test('missing or malformed host acknowledgements never fall back or imply retention', () async {
    final content = _envelope(address.entryId);
    final hash = await recoveryCiphertextHash(content);
    await expectLater(
      broker.append(address, content),
      throwsA(isA<RecoveryStorageUnknown>()),
    );
    messenger.setMockMethodCallHandler(
      channel,
      (_) async => {...address.json, 'status': 'deleted', 'deleted': 'true'},
    );
    await expectLater(
      broker.deleteExact(
        address,
        expectedSha256: hash,
        expectedBytes: utf8.encode(content).length,
        mode: CaptureStorageMode.schema3,
      ),
      throwsA(isA<RecoveryStorageUnknown>()),
    );
  });

  test('only explicit retained and conflict responses are definite non-delete failures', () async {
    final content = _envelope(address.entryId);
    final hash = await recoveryCiphertextHash(content);
    for (final pair in [
      ('recovery_retained', isA<CaptureStorageDeleteRetained>()),
      ('recovery_conflict', isA<RecoveryStorageChanged>()),
      ('recovery_unknown', isA<RecoveryStorageUnknown>()),
      ('recovery_unavailable', isA<RecoveryStorageUnknown>()),
    ]) {
      messenger.setMockMethodCallHandler(
        channel,
        (_) async => throw PlatformException(code: pair.$1),
      );
      await expectLater(
        broker.deleteExact(
          address,
          expectedSha256: hash,
          expectedBytes: utf8.encode(content).length,
          mode: CaptureStorageMode.legacy,
        ),
        throwsA(pair.$2),
      );
    }
  });

  test('legacy mode cannot remove a schema-3 ciphertext even with exact hash and byte count', () async {
    final directory = await Directory.systemTemp.createTemp(
      'capture-broker-mode-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final local = LocalCaptureCiphertextBroker.forTesting(
      () async => directory,
    );
    final content = _envelope(address.entryId);
    final hash = await local.append(address, content);
    await expectLater(
      local.deleteExact(
        address,
        expectedSha256: hash,
        expectedBytes: utf8.encode(content).length,
        mode: CaptureStorageMode.legacy,
      ),
      throwsA(isA<RecoveryStorageChanged>()),
    );
    expect((await local.read(address)).content, content);
    expect(
      await local.deleteExact(
        address,
        expectedSha256: hash,
        expectedBytes: utf8.encode(content).length,
        mode: CaptureStorageMode.schema3,
      ),
      isTrue,
    );
  });

  test('a file-adapter failure after unlink is unknown and never asserted retained', () async {
    final directory = await Directory.systemTemp.createTemp(
      'capture-broker-delete-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final local = LocalCaptureCiphertextBroker.forTesting(
      () async => directory,
      deleteFile: (file) async {
        await file.delete();
        throw const FileSystemException('After unlink');
      },
    );
    final content = _envelope(address.entryId);
    final hash = await local.append(address, content);
    await expectLater(
      local.deleteExact(
        address,
        expectedSha256: hash,
        expectedBytes: utf8.encode(content).length,
        mode: CaptureStorageMode.schema3,
      ),
      throwsA(isA<RecoveryStorageUnknown>()),
    );
    expect((await local.read(address)).content, isNull);
  });

  test('recursive legacy bytes remain counted and observed symbolic links fail closed', () async {
    final directory = await Directory.systemTemp.createTemp(
      'capture-broker-bounds-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final root = Directory(
      '${directory.path}/asael-capture-outbox-v1/${address.secretId}',
    );
    final old = Directory('${root.path}/legacy-cleanup-old');
    await old.create(recursive: true);
    final file = File('${old.path}/${address.secretId}.capture');
    final handle = await file.open(mode: FileMode.write);
    await handle.truncate(captureStorageMaximumBytes);
    await handle.close();
    final local = LocalCaptureCiphertextBroker.forTesting(
      () async => directory,
    );
    await expectLater(
      local.append(address, _envelope(address.entryId)),
      throwsA(isA<RecoveryStorageCapacity>()),
    );
    expect(await file.length(), captureStorageMaximumBytes);
    await file.delete();
    final lock = File('${root.path}/.transaction.lock');
    await lock.delete();
    final outside = File('${directory.path}/outside')
      ..writeAsStringSync('keep');
    await Link(lock.path).create(outside.path);
    await expectLater(
      local.read(address),
      throwsA(isA<RecoveryStorageUnavailable>()),
    );
    expect(await outside.readAsString(), 'keep');
  });
}

String _envelope(String id) => ['metadata', 'payload']
    .map(
      (record) => jsonEncode({
        'schemaVersion': 3,
        'algorithm': 'aes-256-gcm',
        'id': id,
        'record': record,
        'nonce': 'opaque',
        'cipherText': 'é',
        'mac': 'opaque',
      }),
    )
    .join('\n');
