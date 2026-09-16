import 'dart:io';
import 'dart:typed_data';

import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/capture/capture.dart';
import 'package:asael/features/capture/capture_outbox.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory directory;
  late DeviceSecretMaterial secret;
  late CaptureOwnerBinding owner;

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('asael-outbox-test-');
    secret = DeviceSecretMaterial(
      id: 'abcdefghijklmnopqrstuvwx',
      bytes: Uint8List.fromList(List<int>.generate(32, (index) => index)),
    );
    owner = const CaptureOwnerBinding(
      tenantId: 'tenant-one',
      actorId: 'actor:one',
    );
  });

  tearDown(() async {
    if (await directory.exists()) await directory.delete(recursive: true);
  });

  EncryptedCaptureOutbox createOutbox() => EncryptedCaptureOutbox(
    () async => secret,
    directoryProvider: () async => directory,
  );

  test('uses the server-owned cross-platform owner digest contract', () async {
    expect(
      await owner.sha256(),
      'e805018789977bc2b464705983fc7be9467702e8e0b466dfbe2543bfebbd5fc2',
    );
  });

  test('round-trips every offline capture kind', () async {
    final outbox = createOutbox();
    for (final kind in CaptureKind.values) {
      await outbox.enqueue(
        owner,
        CaptureDraft(kind: kind, content: 'capture-${kind.name}'),
      );
    }

    expect(
      (await outbox.list(owner)).map((entry) => entry.draft.kind),
      containsAll(CaptureKind.values),
    );
  });

  test(
    'encrypts a scoped capture and restores its stable retry identity',
    () async {
      final outbox = createOutbox();
      final entry = await outbox.enqueue(
        owner,
        CaptureDraft(
          kind: CaptureKind.meetingMedia,
          title: 'Planning review',
          content: 'Confidential meeting notes',
          tags: const ['planning'],
          file: CaptureAttachment(
            name: 'meeting.m4a',
            contentType: 'audio/mp4',
            bytes: Uint8List.fromList([1, 2, 3, 4]),
          ),
        ),
      );

      final encrypted = await directory
          .list(recursive: true)
          .where((entity) => entity is File && entity.path.endsWith('.capture'))
          .cast<File>()
          .single;
      final raw = await encrypted.readAsString();
      expect(raw, isNot(contains('Confidential meeting notes')));
      expect(raw, isNot(contains('Planning review')));

      final restored = await createOutbox().list(owner);
      expect(restored, hasLength(1));
      expect(restored.single.id, entry.id);
      expect((await createOutbox().get(owner, entry.id))?.id, entry.id);
      expect(restored.single.idempotencyKey, entry.idempotencyKey);
      expect(restored.single.draft.kind, CaptureKind.meetingMedia);
      expect(restored.single.draft.file?.bytes, [1, 2, 3, 4]);
      expect(
        await createOutbox().list(
          const CaptureOwnerBinding(
            tenantId: 'tenant-two',
            actorId: 'actor:one',
          ),
        ),
        isEmpty,
      );
    },
  );

  test(
    'refuses cross-owner deletion and authenticated-data tampering',
    () async {
      final outbox = createOutbox();
      final entry = await outbox.enqueue(
        owner,
        const CaptureDraft(content: 'Durable note'),
      );
      await expectLater(
        outbox.remove(
          const CaptureOwnerBinding(
            tenantId: 'tenant-one',
            actorId: 'actor:two',
          ),
          entry.id,
        ),
        throwsA(isA<CaptureOutboxIntegrityException>()),
      );

      final encrypted = await directory
          .list(recursive: true)
          .where((entity) => entity is File && entity.path.endsWith('.capture'))
          .cast<File>()
          .single;
      final raw = await encrypted.readAsString();
      await encrypted.writeAsString('${raw.substring(0, raw.length - 2)}xx');
      await expectLater(
        outbox.list(owner),
        throwsA(isA<CaptureOutboxIntegrityException>()),
      );
    },
  );
}
