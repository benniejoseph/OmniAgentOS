import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/core/storage/capture_ciphertext_broker.dart';
import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:asael/features/capture/capture.dart';
import 'package:asael/features/capture/capture_outbox.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:cryptography/cryptography.dart';

import 'capture_test_support.dart';

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
      canonicalUserId: 'user-one',
      apiOrigin: 'https://capture.test',
    );
  });

  tearDown(() async {
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
  });

  EncryptedCaptureOutbox createOutbox() => EncryptedCaptureOutbox(
    () async => secret,
    directoryProvider: () async => directory,
    broker: LocalCaptureCiphertextBroker.forTesting(() async => directory),
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
      expect(restored.single.idempotencyKey, entry.idempotencyKey);
      expect(restored.single.draft.kind, CaptureKind.meetingMedia);
      // Listing decrypts only the metadata; an upload opens the payload.
      expect(restored.single.draft.content, isEmpty);
      expect(restored.single.draft.file?.bytes, isEmpty);
      expect(restored.single.draft.file?.byteLength, 4);
      final opened = await createOutbox().get(owner, entry.id);
      expect(opened?.id, entry.id);
      expect(opened?.draft.content, 'Confidential meeting notes');
      expect(opened?.draft.file?.bytes, [1, 2, 3, 4]);
      expect(
        await createOutbox().list(
          const CaptureOwnerBinding(
            tenantId: 'tenant-two',
            actorId: 'actor:one',
            canonicalUserId: 'user-one',
            apiOrigin: 'https://capture.test',
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
            canonicalUserId: 'user-one',
            apiOrigin: 'https://capture.test',
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
      final [metadata, payload] = (await encrypted.readAsString()).split('\n');
      String forged(String envelope) {
        final value = jsonDecode(envelope) as Map<String, Object?>;
        final mac = value['mac']! as String;
        value['mac'] = '${mac.startsWith('A') ? 'B' : 'A'}${mac.substring(1)}';
        return jsonEncode(value);
      }

      await encrypted.writeAsString('$metadata\n${forged(payload)}');
      expect((await outbox.list(owner)).single.id, entry.id);
      await expectLater(
        outbox.get(owner, entry.id),
        throwsA(isA<CaptureOutboxIntegrityException>()),
      );

      await encrypted.writeAsString('${forged(metadata)}\n$payload');
      await expectLater(
        outbox.list(owner),
        throwsA(isA<CaptureOutboxIntegrityException>()),
      );
    },
  );
  test('canonical user and API origin pin survive restart and prevent cross-deployment replay', () async {
    final entry = await createOutbox().enqueue(
      owner,
      const CaptureDraft(content: 'Private predecessor note'),
    );
    final restored = (await createOutbox().list(owner)).single;
    expect(restored.canonicalUserId, owner.canonicalUserId);
    expect(restored.apiOrigin, owner.apiOrigin);
    for (final replacement in [
      CaptureOwnerBinding(
        tenantId: owner.tenantId,
        actorId: owner.actorId,
        canonicalUserId: 'recreated-user',
        apiOrigin: owner.apiOrigin,
      ),
      CaptureOwnerBinding(
        tenantId: owner.tenantId,
        actorId: owner.actorId,
        canonicalUserId: owner.canonicalUserId,
        apiOrigin: 'https://replacement.test',
      ),
    ]) {
      expect(await createOutbox().list(replacement), isEmpty);
      await expectLater(
        createOutbox().get(replacement, entry.id),
        throwsA(isA<CaptureOutboxIntegrityException>()),
      );
      await expectLater(
        createOutbox().remove(replacement, entry.id),
        throwsA(isA<CaptureOutboxIntegrityException>()),
      );
      expect(await replacement.sha256(), await owner.sha256());
    }
    expect(
      (await createOutbox().get(owner, entry.id))!.draft.content,
      'Private predecessor note',
    );
  });
  test('unpinned owners cannot write new encrypted entries', () async {
    await expectLater(
      createOutbox().enqueue(
        CaptureOwnerBinding(tenantId: owner.tenantId, actorId: owner.actorId),
        const CaptureDraft(content: 'No canonical identity'),
      ),
      throwsA(isA<FormatException>()),
    );
    expect(await createOutbox().list(owner), isEmpty);
  });
  for (final schema in [1, 2]) {
    test(
      'schema $schema unpinned entry remains quarantined instead of being adopted by a matching email',
      () async {
        final file = await _writeLegacy(directory, secret, owner, schema);
        expect(await createOutbox().list(owner), isEmpty);
        await expectLater(
          createOutbox().get(owner, 'zzzzzzzzzzzzzzzzzzzzzzzz'),
          throwsA(isA<CaptureOutboxIntegrityException>()),
        );
        expect(await file.exists(), isTrue);
        expect(
          await file.readAsString(),
          isNot(contains('Legacy private note')),
        );
        await createOutbox().enqueue(
          owner,
          const CaptureDraft(content: 'New pinned source'),
        );
        expect(await createOutbox().list(owner), hasLength(1));
      },
    );
  }
  test('normalizes the actual API base and rejects credentials or ambiguous query scope', () {
    expect(
      CaptureOwnerBinding.originForBaseUrl('https://CAPTURE.test/api/'),
      'https://capture.test/api',
    );
    for (final value in [
      'relative',
      'https://user:secret@capture.test',
      'https://capture.test?tenant=one',
    ]) {
      expect(
        () => CaptureOwnerBinding.originForBaseUrl(value),
        throwsFormatException,
      );
    }
  });

  test(
    'explicit reviewed cleanup restores capacity for a full legacy-only queue',
    () async {
      final outbox = createOutbox();
      var encryptedBytes = 0;
      for (var index = 0; index < 25; index++) {
        final file = await _writeLegacy(
          directory,
          secret,
          owner,
          index.isEven ? 1 : 2,
          id: 'legacy${index.toString().padLeft(18, '0')}',
        );
        encryptedBytes += await file.length();
      }
      expect(await outbox.list(owner), isEmpty);
      await expectLater(
        outbox.enqueue(owner, const CaptureDraft(content: 'New source')),
        throwsA(isA<CaptureOutboxCapacityException>()),
      );
      final reviewed = await outbox.inspectLegacy(owner);
      expect(reviewed.count, 25);
      expect(reviewed.encryptedBytes, encryptedBytes);
      expect(reviewed.limited, isFalse);
      final result = await outbox.discardLegacy(
        owner,
        reviewed,
        authorityCurrent: () => true,
      );
      expect(result.removed, 25);
      expect(result.failed, 0);
      expect((await outbox.inspectLegacy(owner)).count, 0);
      await outbox.enqueue(owner, const CaptureDraft(content: 'New source'));
      expect((await outbox.list(owner)).single.draft.title, isEmpty);
    },
  );

  test('cleanup preserves current and foreign schema-3 originals and never adopts legacy plaintext', () async {
    final outbox = createOutbox();
    const foreign = CaptureOwnerBinding(
      tenantId: 'tenant-one',
      actorId: 'actor:one',
      canonicalUserId: 'another-canonical-user',
      apiOrigin: 'https://capture.test',
    );
    final current = await outbox.enqueue(
      owner,
      const CaptureDraft(content: 'Current private original'),
    );
    final other = await outbox.enqueue(
      foreign,
      const CaptureDraft(content: 'Foreign private original'),
    );
    await _writeLegacy(
      directory,
      secret,
      owner,
      1,
      id: 'legacy000000000000000001',
    );
    await _writeLegacy(
      directory,
      secret,
      owner,
      2,
      id: 'legacy000000000000000002',
    );
    final reviewed = await outbox.inspectLegacy(owner);
    expect(reviewed.count, 2);
    expect(
      (await outbox.discardLegacy(
        owner,
        reviewed,
        authorityCurrent: () => true,
      )).removed,
      2,
    );
    expect(
      (await outbox.get(owner, current.id))!.draft.content,
      'Current private original',
    );
    expect(
      (await outbox.get(foreign, other.id))!.draft.content,
      'Foreign private original',
    );
    expect((await outbox.list(owner)).single.id, current.id);
    expect((await outbox.list(foreign)).single.id, other.id);
    expect(
      (await outbox.discardLegacy(
        owner,
        reviewed,
        authorityCurrent: () => true,
      )).stale,
      isTrue,
    );
  });

  test('changed or newly added ciphertext invalidates the whole reviewed inventory before deletion', () async {
    final outbox = createOutbox();
    final file = await _writeLegacy(directory, secret, owner, 1);
    final reviewed = await outbox.inspectLegacy(owner);
    await _writeLegacy(
      directory,
      secret,
      owner,
      1,
    ); // A different ciphertext at the same identity.
    expect(
      (await outbox.discardLegacy(
        owner,
        reviewed,
        authorityCurrent: () => true,
      )).stale,
      isTrue,
    );
    expect(await file.exists(), isTrue);
    final second = await outbox.inspectLegacy(owner);
    final added = await _writeLegacy(
      directory,
      secret,
      owner,
      2,
      id: 'legacy000000000000000002',
    );
    expect(
      (await outbox.discardLegacy(
        owner,
        second,
        authorityCurrent: () => true,
      )).stale,
      isTrue,
    );
    expect(await file.exists(), isTrue);
    expect(await added.exists(), isTrue);
  });

  test('a reviewed path replaced by schema 3 is retained without deleting either file', () async {
    final outbox = createOutbox();
    final legacy = await _writeLegacy(directory, secret, owner, 2);
    final reviewed = await outbox.inspectLegacy(owner);
    final current = await outbox.enqueue(
      owner,
      const CaptureDraft(content: 'Pinned original'),
    );
    final pinned = File(
      '${directory.path}/asael-capture-outbox-v1/${secret.id}/${current.id}.capture',
    );
    final bytes = await pinned.readAsBytes();
    await legacy.writeAsBytes(bytes);
    final result = await outbox.discardLegacy(
      owner,
      reviewed,
      authorityCurrent: () => true,
    );
    expect(result.stale, isTrue);
    expect(result.removed, 0);
    expect(await legacy.readAsBytes(), bytes);
    expect(await pinned.readAsBytes(), bytes);
  });

  test('failed removal stays counted and can be reviewed again without exposing or losing ciphertext', () async {
    final file = await _writeLegacy(directory, secret, owner, 1);
    final original = await file.readAsBytes();
    final outbox = EncryptedCaptureOutbox(
      () async => secret,
      directoryProvider: () async => directory,
      broker: LocalCaptureCiphertextBroker.forTesting(
        () async => directory,
        deleteFile: (_) async =>
            throw const FileSystemException('Synthetic removal failure'),
      ),
    );
    final reviewed = await outbox.inspectLegacy(owner);
    final result = await outbox.discardLegacy(
      owner,
      reviewed,
      authorityCurrent: () => true,
    );
    expect(result.removed, 0);
    expect(result.failed, 1);
    final retained =
        (await directory
                    .list(recursive: true)
                    .where(
                      (entry) =>
                          entry is File && entry.path.endsWith('.capture'),
                    )
                    .toList())
                .single
            as File;
    expect(await retained.readAsBytes(), original);
    final next = createOutbox();
    final remaining = await next.inspectLegacy(owner);
    expect(remaining.count, 1);
    expect(remaining.encryptedBytes, original.length);
    for (var index = 0; index < 24; index++) {
      await next.enqueue(owner, CaptureDraft(content: 'Current source $index'));
    }
    await expectLater(
      next.enqueue(owner, const CaptureDraft(content: 'Over capacity')),
      throwsA(isA<CaptureOutboxCapacityException>()),
    );
    expect(
      (await next.discardLegacy(
        owner,
        remaining,
        authorityCurrent: () => true,
      )).removed,
      1,
    );
    await next.enqueue(
      owner,
      const CaptureDraft(content: 'Capacity recovered'),
    );
    expect(await next.list(owner), hasLength(25));
  });

  test('changing schema-3 version labels cannot make pinned ciphertext eligible for legacy cleanup', () async {
    final outbox = createOutbox();
    final entry = await outbox.enqueue(
      owner,
      const CaptureDraft(content: 'Pinned private original'),
    );
    final file = File(
      '${directory.path}/asael-capture-outbox-v1/${secret.id}/${entry.id}.capture',
    );
    final parts = (await file.readAsString()).split('\n');
    final disguised = parts
        .map((part) {
          final value = Map<String, dynamic>.from(jsonDecode(part) as Map);
          value['schemaVersion'] = 2;
          return jsonEncode(value);
        })
        .join('\n');
    await file.writeAsString(disguised);
    final reviewed = await outbox.inspectLegacy(owner);
    expect(reviewed.count, 0);
    expect(reviewed.unreadableCount, 1);
    expect(
      (await outbox.discardLegacy(
        owner,
        reviewed,
        authorityCurrent: () => true,
      )).removed,
      0,
    );
    expect(await file.readAsString(), disguised);
  });

  test(
    'cleanup requires the reviewed owner and stops after authority loss',
    () async {
      final outbox = createOutbox();
      final file = await _writeLegacy(directory, secret, owner, 1);
      var reviewed = await outbox.inspectLegacy(owner);
      final replacement = CaptureOwnerBinding(
        tenantId: owner.tenantId,
        actorId: owner.actorId,
        canonicalUserId: 'recreated-user',
        apiOrigin: owner.apiOrigin,
      );
      expect(
        (await outbox.discardLegacy(
          replacement,
          reviewed,
          authorityCurrent: () => true,
        )).stale,
        isTrue,
      );
      reviewed = await outbox.inspectLegacy(owner);
      expect(
        (await outbox.discardLegacy(
          owner,
          reviewed,
          authorityCurrent: () => false,
        )).stopped,
        isTrue,
      );
      expect(await file.exists(), isTrue);
    },
  );

  test('cleanup is bounded to the exact reviewed batch and reports additional legacy files', () async {
    final outbox = createOutbox();
    for (var index = 0; index < 26; index++) {
      await _writeLegacy(
        directory,
        secret,
        owner,
        1,
        id: 'legacy${index.toString().padLeft(18, '0')}',
      );
    }
    final reviewed = await outbox.inspectLegacy(owner);
    expect(reviewed.count, 25);
    expect(reviewed.limited, isTrue);
    expect(
      (await outbox.discardLegacy(
        owner,
        reviewed,
        authorityCurrent: () => true,
      )).removed,
      25,
    );
    expect((await outbox.inspectLegacy(owner)).count, 1);
  });

  test(
    'independent outboxes cannot both consume the last inventory slot',
    () async {
      final first = createOutbox(), second = createOutbox();
      for (var index = 0; index < 24; index++) {
        await first.enqueue(owner, CaptureDraft(content: 'Existing $index'));
      }
      Future<Object> attempt(EncryptedCaptureOutbox box) async {
        try {
          return await box.enqueue(
            owner,
            const CaptureDraft(content: 'Last slot'),
          );
        } catch (error) {
          return error;
        }
      }

      final results = await Future.wait([attempt(first), attempt(second)]);
      expect(results.whereType<CaptureOutboxEntry>(), hasLength(1));
      expect(results.whereType<CaptureOutboxCapacityException>(), hasLength(1));
      expect(await first.list(owner), hasLength(25));
    },
  );

  test('unknown append preserves its exact key and admits no POST or new append before fresh inventory', () async {
    final broker = _FaultCaptureBroker(
      LocalCaptureCiphertextBroker.forTesting(() async => directory),
    )..loseAppend = true;
    final outbox = EncryptedCaptureOutbox(
      () async => secret,
      directoryProvider: () async => directory,
      broker: broker,
    );
    final repository = CaptureTestRepository();
    final controller = CaptureController(repository, outbox, owner);
    addTearDown(controller.dispose);
    expect(
      await controller.submit(const CaptureDraft(content: 'Private original')),
      isFalse,
    );
    expect(controller.error, isA<CaptureOutboxWriteUnknown>());
    final unknown = controller.error! as CaptureOutboxWriteUnknown;
    expect(
      await controller.submit(const CaptureDraft(content: 'Second click')),
      isFalse,
    );
    expect(broker.appends, 1);
    expect(repository.submissions, isEmpty);
    broker.failReads = true;
    await expectLater(
      outbox.list(owner),
      throwsA(isA<RecoveryStorageUnavailable>()),
    );
    await expectLater(
      outbox.enqueue(owner, const CaptureDraft(content: 'Still blocked')),
      throwsA(isA<CaptureOutboxWriteUnknown>()),
    );
    broker.failReads = false;
    await controller.initialize();
    expect(controller.pending.single.id, unknown.entryId);
    expect(
      controller.pending.single.idempotencyKey,
      'capture-offline-${unknown.entryId}',
    );
    expect(controller.pending.single.draft.content, isEmpty);
    expect(
      (await outbox.get(owner, unknown.entryId))!.draft.content,
      'Private original',
    );
    expect(repository.submissions, isEmpty);
    expect(broker.appends, 1);
    final replacement = CaptureController(repository, createOutbox(), owner);
    addTearDown(replacement.dispose);
    await replacement.initialize();
    expect(
      replacement.pending.single.idempotencyKey,
      'capture-offline-${unknown.entryId}',
    );
    expect(repository.submissions, isEmpty);
  });

  test('unknown deletion retains exact evidence until explicit fresh read, without another deletion', () async {
    final file = await _writeLegacy(directory, secret, owner, 2);
    final original = await file.readAsString();
    final broker = _FaultCaptureBroker(
      LocalCaptureCiphertextBroker.forTesting(() async => directory),
    )..loseDelete = true;
    final outbox = EncryptedCaptureOutbox(
      () async => secret,
      directoryProvider: () async => directory,
      broker: broker,
    );
    final reviewed = await outbox.inspectLegacy(owner);
    final result = await outbox.discardLegacy(
      owner,
      reviewed,
      authorityCurrent: () => true,
    );
    expect(result.removed, 0);
    expect(result.failed, 0);
    expect(result.unconfirmed, 1);
    expect(
      result.receipts.single.sha256,
      await recoveryCiphertextHash(original),
    );
    expect(result.receipts.single.encryptedBytes, utf8.encode(original).length);
    expect(result.receipts.single.mode, CaptureStorageMode.legacy);
    expect(
      result.receipts.single.disposition,
      CaptureLocalDeletionDisposition.unconfirmed,
    );
    expect(await file.exists(), isFalse);
    expect(
      (await outbox.discardLegacy(
        owner,
        reviewed,
        authorityCurrent: () => true,
      )).stale,
      isTrue,
    );
    broker.failReads = true;
    await expectLater(
      outbox.inspectLegacy(owner),
      throwsA(isA<RecoveryStorageUnavailable>()),
    );
    broker.failReads = false;
    final rescanned = await outbox.inspectLegacy(owner);
    expect(rescanned.count, 0);
    expect(
      rescanned.reconciledDeletions.single.disposition,
      CaptureLocalDeletionDisposition.absent,
    );
    expect(broker.deletes, 1);
  });

  test('a schema-3 receipt retains its pinned exact byte identity after unknown local removal', () async {
    final broker = _FaultCaptureBroker(
      LocalCaptureCiphertextBroker.forTesting(() async => directory),
    );
    final outbox = EncryptedCaptureOutbox(
      () async => secret,
      directoryProvider: () async => directory,
      broker: broker,
    );
    final entry = await outbox.enqueue(
      owner,
      const CaptureDraft(content: 'Pinned bytes'),
    );
    final content = (await broker.read(
      CaptureStorageAddress(secret.id, entry.id),
    )).content!;
    broker.loseDelete = true;
    await expectLater(
      outbox.remove(owner, entry.id),
      throwsA(
        isA<CaptureOutboxDeleteUnknown>()
            .having((error) => error.receipt.entryId, 'entry', entry.id)
            .having(
              (error) => error.receipt.sha256,
              'hash',
              await recoveryCiphertextHash(content),
            )
            .having(
              (error) => error.receipt.mode,
              'mode',
              CaptureStorageMode.schema3,
            ),
      ),
    );
    expect(await outbox.list(owner), isEmpty);
    expect(broker.deletes, 1);
  });

  for (final retained in [false, true]) {
    test(
      'refresh waits behind an admitted delete and never auto-uploads its ${retained ? 'retained' : 'removed'} bytes',
      () async {
        final broker =
            _FaultCaptureBroker(
                LocalCaptureCiphertextBroker.forTesting(() async => directory),
              )
              ..holdDelete = Completer<void>()
              ..retainHeldDelete = retained;
        final outbox = EncryptedCaptureOutbox(
          () async => secret,
          directoryProvider: () async => directory,
          broker: broker,
        );
        final entry = await outbox.enqueue(
          owner,
          const CaptureDraft(content: 'Discarded private draft'),
        );
        final repository = CaptureTestRepository();
        final controller = CaptureController(
          repository,
          outbox,
          owner,
          resumeBatchProcessing: true,
        );
        addTearDown(controller.dispose);
        controller.pending = await outbox.list(owner);
        await controller.discard(entry.id);
        expect(controller.error, isA<CaptureOutboxDeleteUnknown>());
        // A separate engine has neither the first outbox's uncertainty map nor
        // its controller. Normal reads still join the host transaction queue.
        final secondOutbox = EncryptedCaptureOutbox(
          () async => secret,
          directoryProvider: () async => directory,
          broker: broker,
        );
        final replacement = CaptureController(
          repository,
          secondOutbox,
          owner,
          resumeBatchProcessing: true,
        );
        addTearDown(replacement.dispose);
        final refreshing = replacement.initialize();
        final thirdOutbox = EncryptedCaptureOutbox(
          () async => secret,
          directoryProvider: () async => directory,
          broker: broker,
        );
        final exactRead = thirdOutbox.get(owner, entry.id);
        await broker.heldRead.future;
        expect(replacement.loadingOutbox, isTrue);
        expect(repository.submissions, isEmpty);
        expect(broker.deletes, 1);
        broker.holdDelete!.complete();
        await refreshing;
        expect((await exactRead)?.id, retained ? entry.id : isNull);
        expect(repository.submissions, isEmpty);
        expect(replacement.pending, retained ? hasLength(1) : isEmpty);
        expect(broker.deletes, 1);
      },
    );
  }
}

class _FaultCaptureBroker implements CaptureCiphertextBroker {
  _FaultCaptureBroker(this.delegate);
  final CaptureCiphertextBroker delegate;
  bool loseAppend = false, loseDelete = false, failReads = false;
  bool retainHeldDelete = false;
  Completer<void>? holdDelete;
  final heldRead = Completer<void>();
  Future<void>? _pendingDeletion;
  int appends = 0, deletes = 0;
  @override
  Future<RecoveryCiphertext> read(CaptureStorageAddress address) async {
    if (failReads) {
      throw const RecoveryStorageUnavailable();
    }
    if (_pendingDeletion != null) {
      if (!heldRead.isCompleted) {
        heldRead.complete();
      }
      await _pendingDeletion;
    }
    return await delegate.read(address);
  }

  @override
  Future<String> append(
    CaptureStorageAddress address,
    String ciphertext,
  ) async {
    appends++;
    final digest = await delegate.append(address, ciphertext);
    if (loseAppend) {
      throw const RecoveryStorageUnknown();
    }
    return digest;
  }

  @override
  Future<bool> deleteExact(
    CaptureStorageAddress address, {
    required String expectedSha256,
    required int expectedBytes,
    required CaptureStorageMode mode,
  }) async {
    deletes++;
    if (holdDelete != null) {
      _pendingDeletion = () async {
        await holdDelete!.future;
        if (!retainHeldDelete) {
          await delegate.deleteExact(
            address,
            expectedSha256: expectedSha256,
            expectedBytes: expectedBytes,
            mode: mode,
          );
        }
      }();
      throw const RecoveryStorageUnknown();
    }
    final result = await delegate.deleteExact(
      address,
      expectedSha256: expectedSha256,
      expectedBytes: expectedBytes,
      mode: mode,
    );
    if (loseDelete) {
      throw const RecoveryStorageUnknown();
    }
    return result;
  }
}

Future<File> _writeLegacy(
  Directory root,
  DeviceSecretMaterial secret,
  CaptureOwnerBinding owner,
  int schema, {
  String id = 'zzzzzzzzzzzzzzzzzzzzzzzz',
}) async {
  final directory = Directory(
    '${root.path}/asael-capture-outbox-v1/${secret.id}',
  );
  await directory.create(recursive: true);
  final value = <String, Object?>{
    'schemaVersion': schema,
    'id': id,
    'tenantId': owner.tenantId,
    'actorId': owner.actorId,
    'createdAt': DateTime.utc(2026, 1, 1).toIso8601String(),
    'idempotencyKey': 'capture-offline-$id',
    'draft': {
      'kind': 'text',
      'content': 'Legacy private note',
      'title': 'Legacy',
      'tags': [],
    },
  };
  Future<String> envelope(String? record) async {
    final box = await AesGcm.with256bits().encrypt(
      utf8.encode(jsonEncode(value)),
      secretKey: SecretKey(secret.bytes),
      aad: utf8.encode(
        'asael.capture-outbox:$schema:$id${record == null ? '' : ':$record'}',
      ),
    );
    return jsonEncode({
      'schemaVersion': schema,
      'algorithm': 'aes-256-gcm',
      'id': id,
      'record': ?record,
      'nonce': base64UrlEncode(box.nonce),
      'cipherText': base64UrlEncode(box.cipherText),
      'mac': base64UrlEncode(box.mac.bytes),
    });
  }

  final content = schema == 1
      ? await envelope(null)
      : '${await envelope('metadata')}\n${await envelope('payload')}';
  return File('${directory.path}/$id.capture').writeAsString(content);
}
