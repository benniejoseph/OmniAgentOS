import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/quality/quality_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'quality_test_support.dart';

void main() {
  test(
    'refresh coalesces each source and one failure cannot hide the other',
    () async {
      final repo = QualityTestRepository();
      final controller = QualityController(repo);
      final first = controller.refresh(), repeated = controller.refresh();
      await Future<void>.value();
      expect(repo.evaluationsRequests, hasLength(1));
      expect(repo.releaseRequests, hasLength(1));
      repo.evaluationsRequests.single.result.complete(qualitySnapshot());
      repo.releaseRequests.single.result.completeError(
        const ApiException('unavailable', statusCode: 503),
      );
      await Future.wait([first, repeated]);
      expect(controller.evaluations.state, QualityLoadState.ready);
      expect(controller.release.state, QualityLoadState.failed);
      expect(controller.evaluations.data!.runs, hasLength(1));
      expect(controller.loading, isFalse);
      controller.dispose();
    },
  );

  test('repeated operator refresh does not strand the restricted source as pending', () async {
    final repo = QualityTestRepository()..releaseAllowed = false;
    final c = QualityController(repo);
    for (var i = 0; i < 2; i++) {
      final read = c.refresh();
      await Future<void>.value();
      repo.evaluationsRequests.last.result.complete(qualitySnapshot());
      await read;
      expect(c.loading, isFalse);
      expect(c.release.state, QualityLoadState.restricted);
      expect(c.evaluations.data, isNotNull);
    }
    expect(repo.evaluationsRequests, hasLength(2));
    expect(repo.releaseRequests, isEmpty);
    c.dispose();
  });

  test('synchronous repository throws settle and can be retried', () async {
    final repo = QualityTestRepository()
      ..synchronousFailure = StateError('offline');
    final c = QualityController(repo);
    await c.refresh();
    expect(c.loading, isFalse);
    expect(c.evaluations.state, QualityLoadState.failed);
    repo.synchronousFailure = null;
    final retry = c.refreshSource(QualitySource.evaluations);
    await Future<void>.value();
    repo.evaluationsRequests.single.result.complete(qualitySnapshot());
    await retry;
    expect(c.evaluations.state, QualityLoadState.ready);
    expect(c.loading, isFalse);
    c.dispose();
  });

  test('a source refresh immediately clears its selected detail and denial keeps it empty', () async {
    final repo = QualityTestRepository();
    final controller = QualityController(repo);
    final first = controller.refresh();
    await Future<void>.value();
    repo.evaluationsRequests.single.result.complete(qualitySnapshot());
    repo.releaseRequests.single.result.complete(qualityReport());
    await first;
    controller.selectSection(QualitySection.release);
    controller.select('database');
    final denied = controller.refreshSource(QualitySource.release);
    expect(controller.selectedId, isNull);
    expect(controller.release.data, isNull);
    expect(controller.evaluations.data, isNotNull);
    await Future<void>.value();
    repo.releaseRequests.last.result.completeError(
      const ApiException('denied', statusCode: 403),
    );
    await denied;
    expect(controller.release.state, QualityLoadState.restricted);
    expect(controller.release.data, isNull);
    expect(controller.release.receivedAt, isNull);
    expect(controller.evaluations.data, isNotNull);
    controller.dispose();
  });

  test(
    'session denial clears both sources, selection and held reads',
    () async {
      final repo = QualityTestRepository();
      final controller = QualityController(repo);
      final read = controller.refresh();
      await Future<void>.value();
      repo.evaluationsRequests.single.result.completeError(
        const ApiException('expired', statusCode: 401),
      );
      await Future<void>.delayed(Duration.zero);
      expect(repo.releaseRequests.single.cancel.isCancelled, isTrue);
      repo.releaseRequests.single.result.complete(qualityReport());
      await read;
      expect(controller.authorizationDenied, isTrue);
      expect(controller.available, isFalse);
      expect(controller.evaluations.data, isNull);
      expect(controller.release.data, isNull);
      await controller.refresh();
      expect(repo.evaluationsRequests, hasLength(1));
      controller.dispose();
    },
  );

  test(
    'authority refusal on one refresh clears every warm source and selection',
    () async {
      final repo = QualityTestRepository();
      final controller = QualityController(repo);
      addTearDown(controller.dispose);
      final initial = controller.refresh();
      await Future<void>.value();
      repo.evaluationsRequests.single.result.complete(qualitySnapshot());
      repo.releaseRequests.single.result.complete(qualityReport());
      await initial;
      for (final source in QualitySource.values) {
        final lane = controller.lane(source);
        expect(lane.state, QualityLoadState.ready);
        expect(lane.data, isNotNull);
        expect(lane.receivedAt, isNotNull);
      }
      controller.selectSection(QualitySection.release);
      final selectedId = controller.release.data!.gates.first.id;
      controller.select(selectedId);

      final refused = controller.refreshSource(QualitySource.evaluations);
      expect(controller.selectedId, selectedId);
      expect(controller.release.data, isNotNull);
      expect(controller.release.receivedAt, isNotNull);
      await Future<void>.value();
      repo.evaluationsRequests.last.result.completeError(
        const NativeAuthorityVerificationException(),
      );
      await refused;

      expect(controller.authorizationDenied, isTrue);
      expect(controller.available, isFalse);
      expect(controller.loading, isFalse);
      expect(controller.selectedId, isNull);
      for (final source in QualitySource.values) {
        final lane = controller.lane(source);
        expect(lane.state, QualityLoadState.idle);
        expect(lane.data, isNull);
        expect(lane.receivedAt, isNull);
        expect(lane.error, isNull);
      }
      await controller.refresh();
      await controller.refreshSource(QualitySource.release);
      expect(repo.evaluationsRequests, hasLength(2));
      expect(repo.releaseRequests, hasLength(1));
    },
  );

  for (final reason in ['hidden', 'invalidated', 'disposed']) {
    test(
      '$reason clears private selection, cancels reads and rejects late results',
      () async {
        final repo = QualityTestRepository();
        final c = QualityController(repo);
        final old = c.refresh();
        await Future<void>.value();
        switch (reason) {
          case 'hidden':
            c.setVisible(false);
          case 'invalidated':
            c.invalidate(notify: false);
          case 'disposed':
            c.dispose();
        }
        expect(repo.evaluationsRequests.single.cancel.isCancelled, isTrue);
        expect(repo.releaseRequests.single.cancel.isCancelled, isTrue);
        repo.evaluationsRequests.single.result.complete(qualitySnapshot());
        repo.releaseRequests.single.result.complete(qualityReport());
        await old;
        expect(c.evaluations.data, isNull);
        expect(c.release.data, isNull);
        expect(c.selectedId, isNull);
        await c.refresh();
        expect(repo.evaluationsRequests, hasLength(1));
        if (reason == 'hidden') {
          c.setVisible(true);
          final resumed = c.refreshSource(QualitySource.evaluations);
          await Future<void>.value();
          repo.evaluationsRequests.last.result.complete(qualitySnapshot());
          await resumed;
          expect(repo.evaluationsRequests, hasLength(2));
        }
        if (reason != 'disposed') c.dispose();
      },
    );
  }

  test(
    'invalidation inside authority probe and before admission sends no read',
    () async {
      final repo = QualityTestRepository();
      final c = QualityController(repo);
      repo.probe = () => c.invalidate(notify: false);
      await c.refresh();
      expect(repo.evaluationsRequests, isEmpty);
      expect(repo.releaseRequests, isEmpty);
      c.dispose();
      final second = QualityTestRepository();
      final pending = QualityController(second);
      final read = pending.refresh();
      pending.invalidate(notify: false);
      await read;
      expect(second.evaluationsRequests, isEmpty);
      expect(second.releaseRequests, isEmpty);
      pending.dispose();
    },
  );
}
