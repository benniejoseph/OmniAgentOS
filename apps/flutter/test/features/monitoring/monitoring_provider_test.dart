import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/monitoring/monitoring_controller.dart';
import 'package:asael/features/monitoring/monitoring_providers.dart';
import 'package:asael/features/monitoring/monitoring_workspace_view.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'monitoring_test_support.dart';

AppSession _session({
  String tenant = 'tenant-a',
  String actor = 'owner@example.test',
  String user = monitoringUser,
  String role = 'admin',
}) => AppSession(
  tenantId: tenant,
  actorId: actor,
  userId: user,
  email: actor,
  displayName: 'Owner',
  workspaceName: 'Asael',
  role: role,
);

class _Sessions extends SessionController {
  @override
  Future<AppSession?> build() async => _session();
  void replace(AppSession value) => state = AsyncData(value);
}

class _NoSessionEffects extends Fake implements SessionRepository {}

class _MutableOriginApi extends MonitoringTestApi {
  String origin = 'https://workspace.example.test';
  @override
  String get apiBaseUrl => origin;
}

class _Lock extends BiometricSessionLockController {
  _Lock() : super(_NoSessionEffects());
  bool locked = false;
  @override
  BiometricSessionLockState get state => BiometricSessionLockState(
    phase: locked
        ? BiometricSessionLockPhase.locked
        : BiometricSessionLockPhase.unlocked,
  );
  void protect() {
    locked = true;
    notifyListeners();
  }
}

void main() {
  for (final change in [
    'tenant',
    'actor',
    'canonical user',
    'role',
    'API',
    'API base',
    'lock',
    'repository',
  ]) {
    test(
      '$change replacement clears outgoing evidence before rebuilding the provider',
      () async {
        final prior = FlutterError.onError, errors = <FlutterErrorDetails>[];
        FlutterError.onError = errors.add;
        addTearDown(() {
          FlutterError.onError = prior;
          expect(errors, isEmpty);
        });
        var api = _MutableOriginApi();
        final original = api, lock = _Lock();
        late _Sessions sessions;
        final container = ProviderContainer(
          overrides: [
            apiClientProvider.overrideWith((ref) => api),
            sessionControllerProvider.overrideWith(
              () => sessions = _Sessions(),
            ),
            biometricSessionLockControllerProvider.overrideWith((ref) => lock),
          ],
        );
        addTearDown(container.dispose);
        await container.read(sessionControllerProvider.future);
        final provider = monitoringControllerProvider('visible');
        final subscription = container.listen(provider, (_, _) {});
        addTearDown(subscription.close);
        final c = container.read(provider)!;
        final repository = container.read(monitoringRepositoryProvider)!;
        await c.refresh();
        for (final source in MonitoringSource.values) {
          expect(c.lane(source).data, isNotNull);
          expect(c.lane(source).receivedAt, isNotNull);
        }
        final selectedId = c.slo.data!.evaluations.first.policy.id;
        c.select(selectedId);
        final held = Completer<Map<String, dynamic>>();
        api.reader = (_) => held.future;
        final pending = c.refreshSource(MonitoringSource.alerts);
        await Future<void>.value();
        expect(c.selectedId, selectedId);
        var notifications = 0;
        c.addListener(() => notifications++);
        switch (change) {
          case 'tenant':
            sessions.replace(_session(tenant: 'other'));
          case 'actor':
            sessions.replace(_session(actor: 'other@example.test'));
          case 'canonical user':
            sessions.replace(
              _session(user: '22222222-2222-4222-8222-222222222222'),
            );
          case 'role':
            sessions.replace(_session(role: 'operator'));
          case 'API':
            api = _MutableOriginApi();
            container.invalidate(apiClientProvider);
          case 'API base':
            original.origin = 'https://other-workspace.example.test';
          case 'lock':
            lock.protect();
          case 'repository':
            container.invalidate(monitoringRepositoryProvider);
        }
        expect(c.available, isFalse);
        for (final source in MonitoringSource.values) {
          expect(c.lane(source).data, isNull);
          expect(c.lane(source).receivedAt, isNull);
        }
        expect(c.selectedId, isNull);
        expect(original.tokens.last.isCancelled, isTrue);
        if (change == 'API base') {
          expect(notifications, 0);
          original.origin = 'https://workspace.example.test';
          expect(repository.current, isFalse);
          expect(c.available, isFalse);
          await Future<void>.value();
          expect(notifications, greaterThan(0));
          await expectLater(repository.health(CancelToken()), throwsStateError);
        }
        held.complete(monitoringAlertsJson());
        await pending;
        await c.refresh();
        expect(original.paths, hasLength(6));
        expect(c.alerts.data, isNull);
      },
    );
  }
  testWidgets(
    'same-owner repository replacement and hidden return discard old detail',
    (tester) async {
      tester.view.physicalSize = const Size(900, 1200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = MonitoringTestApi();
      var title = 'Prior private measurement';
      api.reader = (path) async {
        final json = monitoringResponse(path);
        if (path == '/api/observability/slo') {
          ((json['policies'] as List).single as Map)['name'] = title;
          (((json['evaluations'] as List).single as Map)['policy']
                  as Map)['name'] =
              title;
        }
        return json;
      };
      final container = ProviderContainer(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          sessionControllerProvider.overrideWith(_Sessions.new),
          biometricSessionLockControllerProvider.overrideWith((ref) => _Lock()),
        ],
      );
      addTearDown(container.dispose);
      await container.read(sessionControllerProvider.future);
      Widget app(bool shown) => UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          home: TickerMode(enabled: shown, child: const NativeMonitoringPage()),
        ),
      );
      await tester.pumpWidget(app(true));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('monitoring-slo-lcp-p75')),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const ValueKey('monitoring-slo-lcp-p75')));
      await tester.pumpAndSettle();
      expect(find.text('Evidence detail'), findsOneWidget);
      title = 'Fresh private measurement';
      container.invalidate(monitoringRepositoryProvider);
      await tester.pumpAndSettle();
      expect(find.text('Prior private measurement'), findsNothing);
      expect(find.text('Evidence detail'), findsNothing);
      final before = api.paths.length;
      await tester.pumpWidget(app(false));
      await tester.pumpAndSettle();
      expect(find.text('Fresh private measurement'), findsNothing);
      title = 'New visibility measurement';
      await tester.pumpWidget(app(true));
      await tester.pumpAndSettle();
      expect(api.paths.length, before + 5);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets(
    'backgrounding discards content and resumes through five fresh GETs',
    (tester) async {
      final api = MonitoringTestApi();
      final container = ProviderContainer(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          sessionControllerProvider.overrideWith(_Sessions.new),
          biometricSessionLockControllerProvider.overrideWith((ref) => _Lock()),
        ],
      );
      addTearDown(container.dispose);
      await container.read(sessionControllerProvider.future);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: NativeMonitoringPage()),
        ),
      );
      await tester.pumpAndSettle();
      expect(api.paths, hasLength(5));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pumpAndSettle();
      expect(find.text('Service health'), findsNothing);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(api.paths, hasLength(10));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
