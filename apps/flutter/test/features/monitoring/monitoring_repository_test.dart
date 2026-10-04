import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/monitoring/monitoring_contracts.dart';
import 'package:asael/features/monitoring/monitoring_controller.dart';
import 'package:asael/features/monitoring/monitoring_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'monitoring_test_support.dart';

void main() {
  test('five reads use the exact authorized paths without cache or effect parameters', () async {
    final api = MonitoringTestApi();
    final access = monitoringAccess(api);
    final actual = ApiMonitoringRepository(access);
    addTearDown(actual.dispose);
    await actual.health(CancelToken());
    await actual.slo(CancelToken());
    await actual.incidents(CancelToken());
    await actual.alerts(CancelToken());
    await actual.timeline(CancelToken());
    expect(api.paths, [
      '/api/health',
      '/api/observability/slo',
      '/api/incidents',
      '/api/alerts',
      '/api/observability',
    ]);
    expect(api.queries, everyElement(isNull));
    expect(
      api.authorities.map(
        (a) => (a.apiBaseUrl, a.tenantId, a.actorId, a.canonicalUserId, a.role),
      ),
      everyElement((
        access.authority.apiBaseUrl,
        'tenant-a',
        'owner@example.test',
        monitoringUser,
        'admin',
      )),
    );
  });
  test('structured health 503 is evidence, while transport failure remains unavailable', () async {
    final api = MonitoringTestApi();
    final repo = ApiMonitoringRepository(monitoringAccess(api));
    addTearDown(repo.dispose);
    api.reader = (_) async => throw ApiException(
      'Unavailable',
      statusCode: 503,
      responseData: monitoringHealthJson(status: 'unhealthy'),
    );
    expect(
      (await repo.health(CancelToken())).status,
      MonitoringHealthStatus.unhealthy,
    );
    api.reader = (_) async => throw ApiException(
      'Unavailable',
      statusCode: 503,
      responseData: monitoringHealthJson(),
    );
    await expectLater(repo.health(CancelToken()), throwsFormatException);
    api.reader = (_) async => throw const ApiException('No connection');
    await expectLater(repo.health(CancelToken()), throwsA(isA<ApiException>()));
  });
  test(
    'operator can read public health but no private operation is dispatched',
    () async {
      final api = MonitoringTestApi();
      final actual = ApiMonitoringRepository(
        monitoringAccess(api, role: 'operator'),
      );
      addTearDown(actual.dispose);
      await actual.health(CancelToken());
      await expectLater(
        actual.slo(CancelToken()),
        throwsA(isA<ApiException>().having((e) => e.statusCode, 'status', 403)),
      );
      expect(api.paths, ['/api/health']);
    },
  );
  test('repository invalidation clears outgoing controller silently and fences late responses', () async {
    final api = MonitoringTestApi();
    final repository = ApiMonitoringRepository(monitoringAccess(api));
    final c = MonitoringController(repository);
    final detach = repository.observeInvalidation(
      () => c.invalidate(notify: false),
    );
    addTearDown(() {
      detach();
      c.dispose();
      repository.dispose();
    });
    await c.refresh();
    c.select('lcp-p75');
    final held = Completer<Map<String, dynamic>>();
    api.reader = (_) => held.future;
    final pending = c.refreshSource(MonitoringSource.health);
    await Future<void>.value();
    var notifications = 0;
    c.addListener(() => notifications++);
    repository.dispose();
    expect(c.slo.data, isNull);
    expect(c.selectedId, isNull);
    expect(c.available, isFalse);
    expect(api.tokens.last.isCancelled, isTrue);
    expect(notifications, 0);
    held.complete(monitoringHealthJson());
    await pending;
    expect(c.health.data, isNull);
  });
  test('invalidation inside the authority probe admits no new read', () async {
    final api = MonitoringTestApi();
    late ApiMonitoringRepository repository;
    repository = ApiMonitoringRepository(
      monitoringAccess(
        api,
        current: () {
          repository.dispose();
          return true;
        },
      ),
    );
    await expectLater(repository.health(CancelToken()), throwsStateError);
    expect(api.paths, isEmpty);
  });
  test('scope changes during a structured health failure do not retain its evidence', () async {
    var current = true;
    final api = MonitoringTestApi();
    final repo = ApiMonitoringRepository(
      monitoringAccess(api, current: () => current),
    );
    addTearDown(repo.dispose);
    api.reader = (_) async {
      current = false;
      throw ApiException(
        'Unavailable',
        statusCode: 503,
        responseData: monitoringHealthJson(status: 'unhealthy'),
      );
    };
    await expectLater(repo.health(CancelToken()), throwsStateError);
  });
}
