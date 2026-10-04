import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/meetings/meetings.dart';
import 'package:asael/features/meetings/meetings_access.dart';
import 'package:asael/features/meetings/meetings_snapshots.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_test_support.dart';

void main() {
  test('initial failure is unavailable; later read failure retains confirmed empty or populated data', () async {
    final repository = FakeMeetingsRepository(),
        controller = MeetingsController(repository);
    repository.listReader = () =>
        Future.error(const ApiException('Unavailable', statusCode: 503));
    await controller.refresh();
    expect(controller.hasLoaded, isFalse);
    expect(controller.meetings, isEmpty);
    repository.listReader = null;
    await controller.refresh();
    expect(controller.hasLoaded, isTrue);
    repository.listReader = () =>
        Future.error(const ApiException('Unavailable', statusCode: 503));
    await controller.refresh();
    expect(controller.meetings.single.id, meetingTestId);
    expect(controller.showingStaleData, isTrue);
    controller.dispose();
  });
  test(
    'last list read wins and biometric/scope invalidation cancels immediately',
    () async {
      final repository = FakeMeetingsRepository(),
          controller = MeetingsController(repository);
      final old = Completer<MeetingsSnapshot>();
      repository.listReader = () => old.future;
      final first = controller.refresh();
      repository.listReader = null;
      await controller.refresh();
      old.complete(
        MeetingsSnapshot.parse({
          'context': meetingContextJson(),
          'meetings': [],
        }, tenantId: meetingOwner.tenantId),
      );
      await first;
      expect(controller.meetings, hasLength(1));
      expect(repository.tokens.first.isCancelled, isTrue);
      repository.access.update(meetingOwner, available: false);
      expect(controller.meetings, isEmpty);
      expect(controller.readable, isFalse);
      controller.dispose();
    },
  );
  test(
    'A to B to A detail race and disposal cannot replace the current route',
    () async {
      final repository = FakeMeetingsRepository();
      final detail = MeetingDetailController(repository, id: meetingTestId),
          held = Completer<MeetingDetailSnapshot>();
      repository.detailReader = (_) => held.future;
      final first = detail.refreshDetail();
      detail.select(meetingOtherId);
      repository.detailReader = null;
      detail.select(meetingTestId);
      await detail.refreshDetail();
      expect(detail.detail!.meeting.id, meetingTestId);
      held.complete(meetingDetail(id: meetingOtherId));
      await first;
      expect(detail.detail!.meeting.id, meetingTestId);
      expect(repository.tokens.first.isCancelled, isTrue);
      final late = Completer<MeetingDetailSnapshot>();
      repository.detailReader = (_) => late.future;
      final last = detail.refreshDetail();
      detail.dispose();
      late.complete(meetingDetail());
      await last;
    },
  );
  test('detail and proposals fail independently and a later current revision invalidates review readiness', () async {
    final repository = FakeMeetingsRepository();
    final detail = MeetingDetailController(repository, id: meetingTestId);
    await detail.refresh();
    expect(detail.currentCommitments, isTrue);
    repository.detailReader = (_) async => meetingDetail(revision: 3);
    await detail.refreshDetail();
    expect(detail.currentCommitments, isFalse);
    repository.commitmentReader = (_) =>
        Future.error(const ApiException('Unavailable', statusCode: 503));
    await detail.refreshCommitments();
    expect(detail.detail!.meeting.revision, 3);
    expect(detail.commitments, isNotNull);
    expect(detail.commitmentsError, isNotNull);
    repository.access.update(
      const MeetingsOwner(
        userId: meetingUserId,
        tenantId: 'other',
        actorId: 'owner@example.test',
        role: 'operator',
        apiScope: 'https://api.example.test',
      ),
      available: false,
    );
    expect(detail.detail, isNull);
    expect(detail.commitments, isNull);
    detail.dispose();
  });
  testWidgets('unchanged pending GETs continue and stop on visibility loss', (
    tester,
  ) async {
    final repository = FakeMeetingsRepository()
      ..detailReader = (_) async => meetingDetail(pending: true);
    final controller = MeetingDetailController(
      repository,
      id: meetingTestId,
      pollInterval: const Duration(seconds: 1),
    );
    await controller.refreshDetail();
    expect(repository.detailReads, 1);
    await tester.pump(const Duration(seconds: 1));
    await tester.pump();
    expect(repository.detailReads, 2);
    await tester.pump(const Duration(seconds: 1));
    await tester.pump();
    expect(repository.detailReads, 3);
    controller.setActive(false);
    await tester.pump(const Duration(seconds: 3));
    expect(repository.detailReads, 3);
    controller.dispose();
  });
}
