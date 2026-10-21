import 'dart:async';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:asael/core/storage/offline_projection_store.dart';
import 'package:asael/core/storage/operation_file_lock.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:flutter_test/flutter_test.dart';

const _owner = ProjectionOwnerBinding(tenantId: 'tenant', actorId: 'actor');
EncryptedOfflineProjectionStore _store(String path) =>
    EncryptedOfflineProjectionStore.durableOperations(
      () async => DeviceSecretMaterial(
        id: 'abcdefghijklmnopqrstuvwx',
        bytes: Uint8List(32),
      ),
      directoryProvider: () async => Directory(path),
    );

void _appendFromEngine(List<Object> args) async {
  final reply = args[0] as SendPort;
  try {
    final store = _store(args[1] as String);
    for (var n = 0; n < 12; n++) {
      await store.exclusively(_owner, 'pending', () async {
        final saved = await store.read(_owner, 'pending');
        final values = List<String>.from(
          saved?.payload['operations'] ?? <String>[],
        );
        await Future<void>.delayed(const Duration(milliseconds: 3));
        await store.write(_owner, 'pending', {
          'operations': [...values, '${args[2]}-$n'],
        });
      });
    }
    reply.send('ok');
  } catch (e, stack) {
    reply.send('$e\n$stack');
  }
}

OperationFileLock? _engineLease;
void _holdFromEngine(List<Object> args) async {
  _engineLease = await OperationFileLock.acquire(args[1] as String);
  (args[0] as SendPort).send('held');
  Timer.periodic(const Duration(seconds: 1), (_) {
    _engineLease.toString();
  });
}

void main() {
  test(
    'independent engines retain every encrypted read-modify-write',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'asael-outbox-engines-',
      );
      try {
        final responses = ReceivePort();
        final engines = <Isolate>[];
        try {
          engines.add(
            await Isolate.spawn(_appendFromEngine, <Object>[
              responses.sendPort,
              directory.path,
              'one',
            ]),
          );
          engines.add(
            await Isolate.spawn(_appendFromEngine, <Object>[
              responses.sendPort,
              directory.path,
              'two',
            ]),
          );
          expect(
            await responses
                .take(2)
                .toList()
                .timeout(const Duration(seconds: 15)),
            ['ok', 'ok'],
          );
          final saved = await _store(directory.path).read(_owner, 'pending');
          final operations = List<String>.from(saved!.payload['operations']);
          expect(operations.toSet(), {
            for (final engine in ['one', 'two'])
              for (var n = 0; n < 12; n++) '$engine-$n',
          });
          expect(operations.length, 24);
        } finally {
          responses.close();
          for (final engine in engines) {
            engine.kill(priority: Isolate.immediate);
          }
        }
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );

  test(
    'an exiting engine releases its native lock for the remaining app',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'asael-outbox-engine-exit-',
      );
      final path = '${directory.path}/pending.lock';
      final reply = ReceivePort();
      final engine = await Isolate.spawn(_holdFromEngine, <Object>[
        reply.sendPort,
        path,
      ]);
      try {
        expect(await reply.first.timeout(const Duration(seconds: 3)), 'held');
        engine.kill(priority: Isolate.immediate);
        final next = await OperationFileLock.acquire(
          path,
          waitLimit: const Duration(seconds: 3),
        );
        next.release();
      } finally {
        engine.kill(priority: Isolate.immediate);
        reply.close();
        await directory.delete(recursive: true);
      }
    },
  );

  test('lock contention is bounded without blocking the event loop', () async {
    final directory = await Directory.systemTemp.createTemp(
      'asael-outbox-lock-',
    );
    final path = '${directory.path}/pending.lock';
    final held = await OperationFileLock.acquire(path);
    try {
      var ticked = false;
      final timer = Timer(
        const Duration(milliseconds: 10),
        () => ticked = true,
      );
      await expectLater(
        OperationFileLock.acquire(
          path,
          waitLimit: const Duration(milliseconds: 50),
        ),
        throwsA(isA<TimeoutException>()),
      );
      expect(ticked, isTrue);
      timer.cancel();
    } finally {
      held.release();
    }
    final next = await OperationFileLock.acquire(
      path,
      waitLimit: const Duration(milliseconds: 50),
    );
    next.release();
    await directory.delete(recursive: true);
  });
}
