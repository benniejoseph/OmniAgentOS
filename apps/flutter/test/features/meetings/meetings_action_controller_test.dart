import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/meetings/meetings_action_controller.dart';
import 'package:asael/features/meetings/meetings_draft_store.dart';
import 'package:asael/features/meetings/meetings_mutations.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_test_support.dart';

void main() {
  test('exclusive synchronous admission freezes exact request through pending edits', () async {
    final repository = FakeMeetingsRepository(),
        store = MemoryMeetingDraftStore();
    final controller = MeetingActionController(repository, store, 'new');
    await controller.initialize();
    final entered = Completer<void>(),
        response = Completer<Map<String, dynamic>>();
    repository.writer = (_) {
      entered.complete();
      return response.future;
    };
    final submitted = createSubmission(),
        first = controller.submit(
          createSubmission(),
          refresh: () async => true,
        );
    expect(controller.busy, isTrue);
    expect(
      await controller.submit(submitted, refresh: () async => true),
      isFalse,
    );
    await entered.future;
    expect(repository.writes, 1);
    controller.updateDraft({
      'kind': 'record',
      'body': {'title': 'Next local draft'},
    });
    final exact = repository.submissions.single;
    response.complete(await createMeetingReceipt(exact));
    expect(await first, isTrue);
    expect(controller.accepted!.submitted.key, exact.key);
    expect(controller.draft['savedReceipt'], isNull);
    expect(controller.draft['body']['title'], 'Next local draft');
    controller.dispose();
  });
  test(
    'accepted receipt settles before a hung refresh and survives failed reads',
    () async {
      final repository = FakeMeetingsRepository()
        ..writer = createMeetingReceipt;
      final controller = MeetingActionController(
        repository,
        MemoryMeetingDraftStore(),
        'new',
      );
      await controller.initialize();
      final refresh = Completer<bool>();
      expect(
        await controller.submit(
          createSubmission(),
          refresh: () => refresh.future,
        ),
        isTrue,
      );
      expect(controller.busy, isFalse);
      expect(controller.accepted, isNotNull);
      expect(controller.needsRefresh, isTrue);
      refresh.complete(false);
      await Future<void>.delayed(Duration.zero);
      expect(controller.accepted, isNotNull);
      expect(controller.refreshError, contains('accepted'));
      controller.dispose();
    },
  );
  test('response loss remains uncertain after retry refusal and reuses only the frozen key/body', () async {
    final repository = FakeMeetingsRepository()
      ..writer = (_) => Future.error(const ApiException('Lost response'));
    final store = MemoryMeetingDraftStore();
    final actions = MeetingActionController(repository, store, 'new');
    await actions.initialize();
    final frozen = createSubmission();
    await actions.submit(frozen, refresh: () async => true);
    expect(actions.uncertain, isTrue);
    repository.writer = (_) =>
        Future.error(const ApiException('Refused', statusCode: 403));
    await actions.retry(refresh: () async => true);
    expect(actions.uncertain, isTrue);
    expect(repository.submissions.map((row) => row.key).toSet(), {frozen.key});
    expect(
      identical(
        repository.submissions.first.body,
        repository.submissions.last.body,
      ),
      isTrue,
    );
    actions.dispose();
    final restored = MeetingActionController(repository, store, 'new');
    await restored.initialize();
    expect(restored.uncertain, isTrue);
    expect(restored.submitted!.key, frozen.key);
    expect(repository.writes, 2);
    restored.dispose();
  });
  test(
    'malformed or wrong-key success never becomes an accepted receipt',
    () async {
      final repository = FakeMeetingsRepository()
        ..writer = (submitted) async {
          final value = await createMeetingReceipt(submitted);
          value['meeting']['title'] = 'Unrelated';
          return value;
        };
      final actions = MeetingActionController(
        repository,
        MemoryMeetingDraftStore(),
        'new',
      );
      await actions.initialize();
      expect(
        await actions.submit(createSubmission(), refresh: () async => true),
        isFalse,
      );
      expect(actions.accepted, isNull);
      expect(actions.uncertain, isTrue);
      actions.dispose();
    },
  );
  test(
    'scope invalidation hides draft/receipt and cannot commit a late response',
    () async {
      final repository = FakeMeetingsRepository(),
          entered = Completer<void>(),
          response = Completer<Map<String, dynamic>>();
      repository.writer = (_) {
        entered.complete();
        return response.future;
      };
      final actions = MeetingActionController(
        repository,
        MemoryMeetingDraftStore(),
        'new',
      );
      await actions.initialize();
      actions.updateDraft({
        'kind': 'record',
        'body': {'title': 'Private'},
      });
      final frozen = createSubmission(),
          writing = actions.submit(
            createSubmission(),
            refresh: () async => true,
          );
      await entered.future;
      repository.access.update(meetingOwner, available: false);
      expect(actions.draft, isEmpty);
      expect(actions.submitted, isNull);
      response.complete(await createMeetingReceipt(frozen));
      expect(await writing, isFalse);
      expect(actions.accepted, isNull);
      actions.dispose();
    },
  );
  test('propose uncertainty has no generic idempotency replay', () async {
    final repository = FakeMeetingsRepository()
      ..writer = (_) => Future.error(const ApiException('Lost response'));
    final actions = MeetingActionController(
      repository,
      MemoryMeetingDraftStore(),
      meetingTestId,
    );
    await actions.initialize();
    final frozen = MeetingSubmission.freeze(
      action: 'propose',
      id: meetingTestId,
      owner: meetingOwner,
      body: {
        'workspaceId': 'workspace:native',
        'mediaRevisionId': 'recording-1:media:v1',
        'actionItemId': 'media-action:${'a' * 64}',
      },
    );
    await actions.submit(frozen, refresh: () async => true);
    expect(actions.uncertain, isTrue);
    expect(await actions.retry(refresh: () async => true), isFalse);
    expect(repository.writes, 1);
    actions.dispose();
  });
}
