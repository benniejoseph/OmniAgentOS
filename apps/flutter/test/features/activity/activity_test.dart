import 'dart:convert';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/activity/activity.dart';
import 'package:flutter_test/flutter_test.dart';

import 'activity_fixture.dart';

void main() {
  test('keeps distinct occurrences sharing one work identity', () {
    final value = snapshot(
      items: [
        reminderFixture(id: 'one'),
        reminderFixture(id: 'two'),
      ],
    );
    expect(value.items, hasLength(2));
    expect(value.items.map((item) => item.workKey).toSet(), hasLength(1));
    expect(value.items.first.nativeLocation, '/today?workItemId=item%2Fshared');
    expect(
      () => snapshot(items: [reminderFixture(), reminderFixture()]),
      throwsFormatException,
    );
  });

  test(
    'exact run and approval links retain encoded slash percent and Unicode',
    () {
      const id = 'identity/with%2Fencoded:Ω';
      final run = snapshot(items: [runFixture(id: id)]).items.single;
      expect(
        Uri.decodeComponent(run.nativeLocation.substring('/results/'.length)),
        'agent:$id',
      );
      expect(run.sourceLabel, 'Inspect run');
      for (final kind in ['tool', 'workflow', 'slo_policy']) {
        final approval = snapshot(
          items: [approvalFixture(id: id, kind: kind)],
        ).items.single;
        final uri = Uri.parse(approval.nativeLocation);
        expect(uri.pathSegments.last, id);
        expect(uri.queryParameters, {'kind': kind});
      }
    },
  );

  test('keeps conversation and linked run identity without claiming native reopening', () {
    final row = approvalFixture();
    row['origin'] = {
      'runId': 'origin/run',
      'threadId': 'conversation:one',
      'href': '/app/command?run=origin%2Frun&thread=conversation%3Aone',
    };
    final item = snapshot(items: [row]).items.single;
    expect(item.originRunId, 'origin/run');
    expect(item.conversationId, 'conversation:one');
    expect(item.sourceLabel, 'Open approval');
    final run = runFixture();
    run['href'] = '/app/command?run=run-one&thread=conversation%3Aone';
    expect(
      snapshot(items: [run]).items.single.conversationId,
      'conversation:one',
    );
    row['origin']['href'] = '/app/command?run=other';
    expect(() => snapshot(items: [row]), throwsFormatException);
  });

  test(
    'unavailable counts differ from successful empty and restricted coverage',
    () {
      expect(snapshot(items: []).known, isTrue);
      final unavailable = snapshot(items: [], state: 'unavailable');
      expect(unavailable.known, isFalse);
      expect(unavailable.coverage['runs']!.visibleCount, isNull);
      final json = activityFixture(state: 'partial');
      (json['coverage'] as Map)['approvals'] = {
        'state': 'restricted',
        'limit': 100,
        'visibleCount': null,
        'reason': 'permission_required',
      };
      final partial = ActivitySnapshot.fromJson(json, ActivityGroup.all);
      expect(partial.known, isTrue);
      expect(partial.coverage['approvals']!.label, 'Access is restricted');
    },
  );

  test('only verified terminal run receipt can claim a verified outcome', () {
    final row = runFixture(group: ActivityGroup.history);
    row['canonicalStatus'] = <String, dynamic>{
      'schemaVersion': 1,
      'domain': 'agent_run',
      'status': 'succeeded',
      'basis': 'terminal_receipt',
      'source': 'outcome_evaluator',
      'sourceStatus': 'succeeded',
      'verificationState': 'verified',
    };
    expect(
      snapshot(items: [row]).items.single.outcomeLabel,
      'Verified outcome',
    );
    (row['canonicalStatus'] as Map<String, dynamic>)['verificationState'] =
        'unassessed';
    expect(() => snapshot(items: [row]), throwsFormatException);
    (row['canonicalStatus'] as Map<String, dynamic>).addAll({
      'status': 'unverified',
      'basis': 'legacy_status',
      'source': 'legacy_adapter',
    });
    expect(
      snapshot(items: [row]).items.single.outcomeLabel,
      'Unverified outcome',
    );
  });

  test('rejects malformed, wrong-scope and unbound source reads', () {
    final changes = <void Function(Map<String, dynamic>)>[
      (json) => json['contract'] = 'other',
      (json) => json['group'] = 'history',
      (json) => json['state'] = ['ready'],
      (json) => (json['items'] as List).first['sourceRef']['kind'] = ['run'],
      (json) =>
          (json['items'] as List).first['href'] = '/app/command?run=other',
      (json) =>
          (json['items'] as List).first['href'] = 'https://external.invalid',
      (json) =>
          (json['items'] as List).first['timestamp']['basis'] = ['started'],
      (json) => (json['page'] as Map)['limit'] = 100,
      (json) => (json['window'] as Map)['bounded'] = false,
      (json) => (json['coverage'] as Map)['runs']['visibleCount'] = 101,
      (json) => (json['counts'] as Map)['working'] = 301,
    ];
    for (final change in changes) {
      final json =
          jsonDecode(jsonEncode(activityFixture())) as Map<String, dynamic>;
      change(json);
      expect(
        () => ActivitySnapshot.fromJson(json, ActivityGroup.all),
        throwsFormatException,
      );
    }
  });

  test(
    'replaced and disposed reads cancel and cannot change current rows',
    () async {
      final repository = ControlledActivityRepository();
      final controller = ActivityController(repository);
      final old = controller.refresh();
      final fresh = controller.select(ActivityGroup.history);
      expect(repository.reads.first.cancelToken.isCancelled, isTrue);
      repository.reads.last.result.complete(
        snapshot(
          group: ActivityGroup.history,
          items: [runFixture(id: 'fresh', group: ActivityGroup.history)],
        ),
      );
      await fresh;
      repository.reads.first.result.complete(
        snapshot(items: [runFixture(id: 'obsolete')]),
      );
      await old;
      expect(controller.snapshot!.items.single.sourceRef.id, 'fresh');
      final pending = controller.refresh();
      controller.dispose();
      expect(repository.reads.last.cancelToken.isCancelled, isTrue);
      repository.reads.last.result.complete(
        snapshot(items: [runFixture(id: 'after-dispose')]),
      );
      await pending;
      expect(controller.snapshot!.items.single.sourceRef.id, 'fresh');
    },
  );

  test(
    'an initial malformed or failed read cannot establish empty counts',
    () async {
      final repository = ControlledActivityRepository();
      final controller = ActivityController(repository);
      addTearDown(controller.dispose);
      for (final failure in [
        const FormatException('Invalid'),
        const ApiException('Unavailable'),
      ]) {
        final pending = controller.refresh();
        repository.reads.last.result.completeError(failure);
        await pending;
        expect(controller.snapshot, isNull);
        expect(controller.error, isNotNull);
        expect(controller.loading, isFalse);
      }
    },
  );

  test(
    'read failures retain last loaded rows; access failures clear them',
    () async {
      final repository = ControlledActivityRepository();
      final controller = ActivityController(repository);
      addTearDown(controller.dispose);
      final first = controller.refresh();
      repository.reads.last.result.complete(snapshot());
      await first;
      final known = controller.snapshot;
      final failed = controller.refresh();
      expect(controller.stale, isTrue);
      repository.reads.last.result.completeError(
        const ApiException('Source unavailable'),
      );
      await failed;
      expect(controller.snapshot, same(known));
      expect(controller.error, 'Source unavailable');
      final unavailable = controller.refresh();
      repository.reads.last.result.complete(
        snapshot(items: [], state: 'unavailable'),
      );
      await unavailable;
      expect(controller.snapshot, same(known));
      for (final status in [401, 403]) {
        final denied = controller.refresh();
        repository.reads.last.result.completeError(
          ApiException('Denied', statusCode: status),
        );
        await denied;
        expect(controller.snapshot, isNull);
        expect(controller.canNext, isFalse);
        expect(controller.error, contains('access'));
      }
    },
  );

  test(
    'expired cursor performs exactly one fresh read and resets paging',
    () async {
      final repository = ControlledActivityRepository();
      final controller = ActivityController(repository);
      addTearDown(controller.dispose);
      final first = controller.refresh();
      repository.reads.last.result.complete(
        snapshot(cursor: 'cursor-one', workingCount: 26),
      );
      await first;
      final next = controller.next();
      expect(repository.reads.last.cursor, 'cursor-one');
      repository.reads.last.result.completeError(
        const ApiConflictException('Window changed'),
      );
      await Future<void>.delayed(Duration.zero);
      expect(repository.reads, hasLength(3));
      expect(repository.reads.last.cursor, isNull);
      repository.reads.last.result.complete(
        snapshot(items: [runFixture(id: 'new-window')]),
      );
      await next;
      expect(controller.pageIndex, 0);
      expect(controller.notice, contains('first page'));
      expect(controller.snapshot!.items.single.sourceRef.id, 'new-window');
      expect(controller.canPrevious, isFalse);
    },
  );

  test('fresh first page replaces the old forward cursor trail', () async {
    final repository = ControlledActivityRepository();
    final controller = ActivityController(repository);
    addTearDown(controller.dispose);
    final first = controller.refresh();
    repository.reads.last.result.complete(
      snapshot(cursor: 'old-cursor', workingCount: 26),
    );
    await first;
    final next = controller.next();
    repository.reads.last.result.complete(
      snapshot(items: [runFixture(id: 'page-two')], workingCount: 26),
    );
    await next;
    expect(controller.pageIndex, 1);
    final previous = controller.previous();
    expect(repository.reads.last.cursor, isNull);
    repository.reads.last.result.complete(
      snapshot(cursor: 'fresh-cursor', workingCount: 26),
    );
    await previous;
    final freshNext = controller.next();
    expect(repository.reads.last.cursor, 'fresh-cursor');
    repository.reads.last.result.complete(snapshot(workingCount: 26));
    await freshNext;
  });

  test(
    'cursor replacement failure is bounded and retains the prior page',
    () async {
      final repository = ControlledActivityRepository();
      final controller = ActivityController(repository);
      addTearDown(controller.dispose);
      final first = controller.refresh();
      repository.reads.last.result.complete(
        snapshot(cursor: 'expired', workingCount: 26),
      );
      await first;
      final retained = controller.snapshot;
      final next = controller.next();
      repository.reads.last.result.completeError(
        const ApiConflictException('Expired'),
      );
      await Future<void>.delayed(Duration.zero);
      repository.reads.last.result.completeError(
        const ApiConflictException('Still expired'),
      );
      await next;
      expect(repository.reads, hasLength(3));
      expect(controller.snapshot, same(retained));
      expect(controller.error, contains('replacement could not be loaded'));
      expect(controller.loading, isFalse);
    },
  );
}
