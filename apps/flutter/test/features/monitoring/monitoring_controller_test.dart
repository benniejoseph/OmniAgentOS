import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/monitoring/monitoring_contracts.dart';
import 'package:asael/features/monitoring/monitoring_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'monitoring_test_support.dart';

void main() {
  test('refresh coalesces each source while independent failures preserve other evidence', () async {
    final repo = MonitoringTestRepository();
    final controller = MonitoringController(repo);
    addTearDown(controller.dispose);
    final first = controller.refresh(), repeated = controller.refresh();
    await Future<void>.value();
    expect(repo.healthRequests, hasLength(1));
    expect(repo.sloRequests, hasLength(1));
    expect(repo.incidentRequests, hasLength(1));
    expect(repo.alertRequests, hasLength(1));
    expect(repo.timelineRequests, hasLength(1));
    repo.sloRequests.single.result.completeError(
      const FormatException('Malformed'),
    );
    repo.completeAll();
    await Future.wait([first, repeated]);
    expect(controller.slo.state, MonitoringLoadState.failed);
    expect(controller.health.data, isNotNull);
    expect(controller.incidents.data, isNotNull);
    expect(controller.alerts.data, isNotNull);
    expect(controller.timeline.data, isNotNull);
    expect(controller.loading, isFalse);
  });
  test(
    'synchronous refusals settle pending futures and allow a fresh retry',
    () async {
      final repo = MonitoringTestRepository()
        ..synchronousFailure = const ApiException('Network unavailable');
      final c = MonitoringController(repo);
      addTearDown(c.dispose);
      await c.refresh();
      expect(c.loading, isFalse);
      expect(c.health.state, MonitoringLoadState.failed);
      repo.synchronousFailure = null;
      final pending = c.refresh();
      await Future<void>.value();
      repo.completeAll();
      await pending;
      expect(c.health.state, MonitoringLoadState.ready);
    },
  );
  test('operator health survives local private-source restrictions without dispatch', () async {
    final repo = MonitoringTestRepository()..privateAllowed = false;
    final c = MonitoringController(repo);
    addTearDown(c.dispose);
    final pending = c.refresh();
    await Future<void>.value();
    repo.completeAll();
    await pending;
    expect(c.health.data, isNotNull);
    expect(c.slo.state, MonitoringLoadState.restricted);
    expect(c.incidents.state, MonitoringLoadState.restricted);
    expect(c.alerts.state, MonitoringLoadState.restricted);
    expect(c.timeline.state, MonitoringLoadState.restricted);
    expect(repo.sloRequests, isEmpty);
    expect(repo.incidentRequests, isEmpty);
    expect(repo.alertRequests, isEmpty);
    expect(repo.timelineRequests, isEmpty);
    expect(c.loading, isFalse);
  });
  test('server 403 clears all private lanes, cancels pending reads and preserves health', () async {
    final repo = MonitoringTestRepository();
    final c = MonitoringController(repo);
    addTearDown(c.dispose);
    final initial = c.refresh();
    await Future<void>.value();
    repo.completeAll();
    await initial;
    c.select('lcp-p75');
    final alerts = c.refreshSource(MonitoringSource.alerts),
        timeline = c.refreshSource(MonitoringSource.timeline);
    await Future<void>.value();
    repo.alertRequests.last.result.completeError(
      const ApiException('Forbidden', statusCode: 403),
    );
    await alerts;
    expect(c.health.data, isNotNull);
    expect(c.slo.data, isNull);
    expect(c.incidents.data, isNull);
    expect(c.selectedId, isNull);
    expect(repo.timelineRequests.last.cancel.isCancelled, isTrue);
    repo.completeAll();
    await timeline;
    expect(c.timeline.data, isNull);
    await c.refreshSource(MonitoringSource.slo);
    expect(repo.sloRequests, hasLength(1));
    expect(c.loading, isFalse);
  });
  test('server 401 clears all evidence and blocks further reads', () async {
    final repo = MonitoringTestRepository();
    final c = MonitoringController(repo);
    addTearDown(c.dispose);
    final pending = c.refresh();
    await Future<void>.value();
    repo.sloRequests.single.result.completeError(
      const ApiException('Expired', statusCode: 401),
    );
    await Future<void>.value();
    repo.completeAll();
    await pending;
    expect(c.authorizationDenied, isTrue);
    expect(c.available, isFalse);
    expect(c.health.data, isNull);
    expect(c.incidents.data, isNull);
    await c.refresh();
    expect(repo.healthRequests, hasLength(1));
  });
  test(
    'hiding clears selection and every lane; late reads cannot reappear',
    () async {
      final repo = MonitoringTestRepository();
      final c = MonitoringController(repo);
      addTearDown(c.dispose);
      final pending = c.refresh();
      await Future<void>.value();
      c.select('lcp-p75');
      c.setVisible(false);
      expect(c.selectedId, isNull);
      expect(repo.healthRequests.single.cancel.isCancelled, isTrue);
      expect(repo.sloRequests.single.cancel.isCancelled, isTrue);
      repo.completeAll();
      await pending;
      expect(c.health.data, isNull);
      expect(c.slo.data, isNull);
      c.setVisible(true);
      final fresh = c.refresh();
      await Future<void>.value();
      repo.completeAll();
      await fresh;
      expect(repo.healthRequests, hasLength(2));
      expect(c.health.data!.status, MonitoringHealthStatus.healthy);
    },
  );
}
