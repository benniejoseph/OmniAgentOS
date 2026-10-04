import 'dart:convert';
import 'dart:io';

import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:asael/features/meetings/meetings_access.dart';
import 'package:asael/features/meetings/meetings_draft_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_test_support.dart';
import 'meetings_recovery_test_support.dart';

void main() {
  late Directory directory;
  late EncryptedMeetingDraftStore store;
  EncryptedMeetingDraftStore createStore({CiphertextRecoveryBroker? broker}) =>
      EncryptedMeetingDraftStore(
        () async => meetingRecoverySecret,
        broker:
            broker ??
            LocalCiphertextRecoveryBroker.forTesting(() async => directory),
      );
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('asael-meeting-drafts-');
    store = createStore();
  });
  tearDown(() async {
    await directory.delete(recursive: true);
  });
  Future<List<File>> records() async =>
      (await directory.list(recursive: true).toList())
          .whereType<File>()
          .where((file) => file.path.endsWith('.meeting'))
          .toList();
  test('draft and frozen uncertainty survive restart encrypted without plaintext identity/content', () async {
    final payload = {
      'draft': {'subject': 'private-subject', 'body': 'private-body'},
      'pending': createSubmission().json,
      'recorded': null,
    };
    await store.write(
      meetingOwner,
      meetingTestId,
      payload,
      isCurrent: () => true,
    );
    final restored = createStore();
    expect(await restored.read(meetingOwner, meetingTestId), payload);
    final disk = await (await records()).single.readAsString();
    expect(disk, isNot(contains('private-body')));
    expect(disk, isNot(contains(meetingUserId)));
    expect(disk, isNot(contains(meetingTestId)));
  });
  test('same display actor cannot recover another UUID, tenant, role, API or route', () async {
    await store.write(meetingOwner, meetingTestId, {
      'draft': {'text': 'private'},
    }, isCurrent: () => true);
    for (final owner in [
      MeetingsOwner(
        userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        tenantId: meetingOwner.tenantId,
        actorId: meetingOwner.actorId,
        role: meetingOwner.role,
        apiScope: meetingOwner.apiScope,
      ),
      MeetingsOwner(
        userId: meetingUserId,
        tenantId: 'other',
        actorId: meetingOwner.actorId,
        role: meetingOwner.role,
        apiScope: meetingOwner.apiScope,
      ),
      MeetingsOwner(
        userId: meetingUserId,
        tenantId: meetingOwner.tenantId,
        actorId: meetingOwner.actorId,
        role: 'viewer',
        apiScope: meetingOwner.apiScope,
      ),
      MeetingsOwner(
        userId: meetingUserId,
        tenantId: meetingOwner.tenantId,
        actorId: meetingOwner.actorId,
        role: meetingOwner.role,
        apiScope: '${meetingOwner.apiScope}/other',
      ),
    ]) {
      expect(await store.read(owner, meetingTestId), isNull);
    }
    expect(await store.read(meetingOwner, meetingOtherId), isNull);
  });
  test('corrupt protected intent fails closed and is not removed', () async {
    await store.write(meetingOwner, meetingTestId, {
      'pending': createSubmission().json,
    }, isCurrent: () => true);
    final file = (await records()).single,
        payload = jsonDecode(
          await (await records()).single.readAsString(),
        ) as Map<String, dynamic>;
    final bytes = base64Decode(payload['ciphertext'] as String);
    bytes[0] ^= 1;
    payload['ciphertext'] = base64Encode(bytes);
    await file.writeAsString(jsonEncode(payload));
    await expectLater(
      store.read(meetingOwner, meetingTestId),
      throwsA(anything),
    );
    expect(await file.exists(), isTrue);
    await expectLater(
      store.write(meetingOwner, meetingTestId, {
        'draft': {'replacement': 'must not erase corrupt recovery'},
      }, isCurrent: () => true),
      throwsA(isA<RecoveryStorageUnknown>()),
    );
    expect(jsonDecode(await file.readAsString()), payload);
  });
  test('independent stores compete against the same observed ciphertext and only one pending key commits', () async {
    final other = createStore();
    expect(await store.read(meetingOwner, 'new'), isNull);
    expect(await other.read(meetingOwner, 'new'), isNull);
    final first = {
          'draft': <String, dynamic>{},
          'pending': createSubmission().json,
        },
        second = {
          'draft': <String, dynamic>{},
          'pending': createSubmission().json,
        };
    Future<Object?> attempt(
      EncryptedMeetingDraftStore writer,
      Map<String, dynamic> payload,
    ) async {
      try {
        await writer.write(meetingOwner, 'new', payload, isCurrent: () => true);
        return null;
      } catch (error) {
        return error;
      }
    }

    final results = await Future.wait([
      attempt(store, first),
      attempt(other, second),
    ]);
    expect(results.where((result) => result == null).length, 1);
    expect(results.whereType<RecoveryStorageChanged>().length, 1);
    final winner = results[0] == null ? first : second,
        loser = results[0] == null ? other : store;
    expect(await createStore().read(meetingOwner, 'new'), winner);
    await expectLater(
      loser.write(meetingOwner, 'new', second, isCurrent: () => true),
      throwsA(isA<RecoveryStorageUnknown>()),
    );
    expect(await loser.read(meetingOwner, 'new'), winner);
    await loser.write(meetingOwner, 'new', {
      'draft': {'adopted': true},
      'pending': winner['pending'],
    }, isCurrent: () => true);
    expect(
      (await createStore().read(meetingOwner, 'new'))!['pending'],
      winner['pending'],
    );
  });
  test('committed save with lost acknowledgement requires a decrypting read before another CAS', () async {
    final broker = MeetingTestRecoveryBroker(
      LocalCiphertextRecoveryBroker.forTesting(() async => directory),
    )..afterWrite = (_) async => throw const RecoveryStorageUnknown();
    final writer = createStore(broker: broker),
        pending = createSubmission().json;
    await expectLater(
      writer.write(meetingOwner, 'new', {
        'draft': {},
        'pending': pending,
      }, isCurrent: () => true),
      throwsA(isA<RecoveryStorageUnknown>()),
    );
    broker.afterWrite = null;
    await expectLater(
      writer.write(meetingOwner, 'new', {
        'draft': {},
        'pending': null,
      }, isCurrent: () => true),
      throwsA(isA<RecoveryStorageUnknown>()),
    );
    expect(broker.writes, 1);
    expect((await writer.read(meetingOwner, 'new'))!['pending'], pending);
    await writer.write(meetingOwner, 'new', {
      'draft': {},
      'pending': pending,
    }, isCurrent: () => true);
    expect(broker.writes, 2);
  });
  test(
    'failed fresh read cannot reuse an earlier known ciphertext baseline',
    () async {
      final broker = MeetingTestRecoveryBroker(
            LocalCiphertextRecoveryBroker.forTesting(() async => directory),
          ),
          writer = createStore(broker: broker);
      await writer.write(meetingOwner, 'new', {
        'draft': {},
      }, isCurrent: () => true);
      broker.beforeRead = () async => throw const RecoveryStorageUnavailable();
      await expectLater(
        writer.read(meetingOwner, 'new'),
        throwsA(isA<RecoveryStorageUnavailable>()),
      );
      await expectLater(
        writer.write(meetingOwner, 'new', {
          'draft': {'changed': true},
        }, isCurrent: () => true),
        throwsA(isA<RecoveryStorageUnknown>()),
      );
      expect(broker.writes, 1);
      broker.beforeRead = null;
      await writer.read(meetingOwner, 'new');
      await writer.write(meetingOwner, 'new', {
        'draft': {'changed': true},
      }, isCurrent: () => true);
      expect(broker.writes, 2);
    },
  );
}
