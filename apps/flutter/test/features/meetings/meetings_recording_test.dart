import 'dart:async';

import 'package:asael/features/meetings/meetings_mutations.dart';
import 'package:asael/features/meetings/meetings_recording_contracts.dart';
import 'package:asael/features/meetings/meetings_recording_controller.dart';
import 'package:asael/features/meetings/meetings_validation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_recording_fixtures.dart';
import 'meetings_test_support.dart';

Future<MeetingRecordingController> ready(
  RecordingRepository repository,
  RecordingStore store,
) async {
  final controller = MeetingRecordingController(repository, store)
    ..setActive(true);
  for (var count = 0; count < 20 && !controller.initialized; count++) {
    await Future<void>.delayed(Duration.zero);
  }
  expect(controller.initialized, isTrue);
  return controller;
}

Future<void> submit(MeetingRecordingController controller) async =>
    controller.submit(
      await recordingReview(),
      languages: ['en'],
      mappings: [],
      isCurrent: () => true,
    );

void main() {
  test('exact acceptance validates source, key, long-key authority and separate projections', () async {
    final sent = await recordingSubmission(key: 'k' * 300);
    final parsed = await MeetingRecordingResult.parse(
      await recordingResultFixture(sent, phase: 'reconciliation_required'),
      meetingOwner,
      sent,
      mutation: true,
    );
    expect(parsed.processing!['media'], isNotNull);
    expect((parsed.processing!['knowledge'] as Map)['state'], 'unconfirmed');
    final wrong = await recordingSubmission(key: 'different-key');
    await expectLater(
      MeetingRecordingResult.parse(
        parsed.raw,
        meetingOwner,
        wrong,
        mutation: true,
      ),
      throwsFormatException,
    );
    final badBody = {...parsed.raw}..remove('serviceReceipt');
    badBody['acceptance'] = {
      ...meetingMap(badBody['acceptance']),
      'sourceAudioManifestSha256': '0' * 64,
    };
    final bad = await recordingSeal(
      badBody,
      'app.meetings.recordings.process',
      sent: sent,
    );
    await expectLater(
      MeetingRecordingResult.parse(bad, meetingOwner, sent, mutation: true),
      throwsFormatException,
    );
  });
  test('review and normalized choices reject policy drift and guessed participant identity', () async {
    final review = await recordingReview();
    await expectLater(
      MeetingRecordingSubmission.prepare(
        meetingOwner,
        review,
        languages: ['en', 'en'],
        mappings: [],
      ),
      throwsFormatException,
    );
    await expectLater(
      MeetingRecordingSubmission.prepare(
        meetingOwner,
        review,
        languages: ['en'],
        mappings: [
          {
            'speakerLabel': 'speaker 1',
            'participantId': 'other',
            'displayName': 'Owner',
            'confirmation': 'user_confirmed',
          },
        ],
      ),
      throwsFormatException,
    );
    final body = await recordingReviewFixture();
    final raw = meetingMap(body['review']), pin = meetingMap(raw['pin']);
    pin['policySha256'] = '0' * 64;
    pin['reviewSha256'] = await meetingSha({...pin}..remove('reviewSha256'));
    final changed = await recordingSeal(
      {
        ...body,
        'review': {...raw, 'pin': pin},
      }..remove('serviceReceipt'),
      'app.meetings.recordings.review',
    );
    await expectLater(
      MeetingRecordingReview.parse(changed, meetingOwner, testRecordingScope()),
      throwsFormatException,
    );
  });
  test('protected dispatched request precedes POST; restart and null GET never send again', () async {
    final repository = RecordingRepository(), store = RecordingStore();
    repository.onProcess = (sent) async {
      final journal = await store.read(
        meetingOwner,
        MeetingRecordingController.route,
      );
      expect(journal!['pendingDispatched'], isTrue);
      expect((journal['pending'] as Map)['requestSha256'], sent.requestSha256);
      throw StateError('Response lost');
    };
    final first = await ready(repository, store);
    await submit(first);
    expect(repository.posts, 1);
    expect(first.pending, isNotNull);
    first.dispose();
    final restored = await ready(repository, store);
    repository.onExact = (sent) =>
        recordingResultFixture(sent, mutation: false, absent: true);
    await restored.check(restored.pending!);
    expect(restored.pending, isNotNull);
    expect(repository.posts, 1);
    repository.onExact = (sent) =>
        recordingResultFixture(sent, mutation: false, phase: 'completed');
    await restored.check(restored.pending!);
    expect(restored.pending, isNull);
    expect(restored.saved.single.result.processing!['phase'], 'completed');
    expect(repository.posts, 1);
    restored.dispose();
  });
  test(
    'delayed review loses foreground admission before any journal or POST',
    () async {
      final repository = RecordingRepository(),
          store = RecordingStore(),
          controller = await ready(repository, store);
      var current = true;
      repository.heldReview = Completer();
      final future = controller.submit(
        await recordingReview(),
        languages: ['en'],
        mappings: [],
        isCurrent: () => current,
      );
      current = false;
      repository.heldReview!.complete(await recordingReviewFixture());
      await future;
      expect(repository.posts, 0);
      expect(store.values, isEmpty);
      expect(controller.busy, isFalse);
      controller.dispose();
    },
  );
  test(
    'missing protected journal cannot release a dispatched uncertain request',
    () async {
      final repository = RecordingRepository(),
          store = RecordingStore(),
          controller = await ready(repository, store);
      repository.onProcess = (_) async => throw StateError('Timeout');
      await submit(controller);
      final key = controller.pending!.key;
      store.values.clear();
      await controller.reload();
      expect(controller.pending!.key, key);
      expect(controller.storageUnconfirmed, isTrue);
      expect(controller.canSubmit, isFalse);
      controller.dispose();
    },
  );
  test(
    'accepted response survives failed local save and unavailable read',
    () async {
      final repository = RecordingRepository(),
          store = RecordingStore(),
          controller = await ready(repository, store);
      repository.onProcess = (sent) async {
        store.failWrites = true;
        return recordingResultFixture(sent);
      };
      await submit(controller);
      final accepted = controller.saved.single.result.acceptance;
      expect(controller.pending, isNull);
      expect(controller.storageUnconfirmed, isTrue);
      repository.onExact = (_) async => throw StateError('Read unavailable');
      await controller.check(controller.saved.single.request);
      expect(controller.saved.single.result.acceptance, accepted);
      store.failWrites = false;
      await controller.reload();
      expect(controller.pending, isNull);
      expect(controller.saved.single.result.acceptance, accepted);
      await controller.saveLocally();
      expect(controller.storageUnconfirmed, isFalse);
      expect(repository.posts, 1);
      controller.dispose();
    },
  );
}
