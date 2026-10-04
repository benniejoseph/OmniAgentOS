import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/quality/quality_controller.dart';
import 'package:asael/features/quality/quality_providers.dart';
import 'package:asael/features/quality/quality_workspace_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'quality_test_fixtures.dart';
import 'quality_test_support.dart';

AppSession _session({
  String tenant = 'tenant-a',
  String actor = 'owner@example.test',
  String user = qualityUser,
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
    'lock',
    'repository',
  ]) {
    test(
      '$change replacement synchronously clears old evidence before provider rebuild',
      () async {
        final previous = FlutterError.onError, errors = <FlutterErrorDetails>[];
        FlutterError.onError = errors.add;
        addTearDown(() {
          FlutterError.onError = previous;
          expect(errors, isEmpty);
        });
        var api = QualityTestApi();
        final first = api, lock = _Lock();
        late _Sessions sessions;
        api.reader = (path) async => path == '/api/evaluations'
            ? qualityEvaluationsJson()
            : qualityReleaseJson();
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
        final provider = qualityControllerProvider('visibility');
        final subscription = container.listen(provider, (_, _) {});
        addTearDown(subscription.close);
        final c = container.read(provider)!;
        await c.refresh();
        c.select('eval-run-1');
        final held = Completer<Map<String, dynamic>>();
        api.reader = (_) => held.future;
        final pending = c.refreshSource(QualitySource.release);
        await Future<void>.value();
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
            sessions.replace(_session(role: 'viewer'));
          case 'API':
            api = QualityTestApi();
            container.invalidate(apiClientProvider);
          case 'lock':
            lock.protect();
          case 'repository':
            container.invalidate(qualityRepositoryProvider);
        }
        expect(c.available, isFalse);
        expect(c.evaluations.data, isNull);
        expect(c.release.data, isNull);
        expect(c.selectedId, isNull);
        expect(first.tokens.last.isCancelled, isTrue);
        held.complete(qualityReleaseJson());
        await pending;
        await c.refresh();
        expect(first.paths, hasLength(3));
        expect(c.release.data, isNull);
      },
    );
  }

  testWidgets(
    'same-owner repository replacement removes old selected detail and hidden return reads fresh',
    (tester) async {
      tester.view.physicalSize = const Size(900, 1100);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = QualityTestApi();
      var suite = 'Private prior suite';
      api.reader = (path) async {
        if (path != '/api/evaluations') return qualityReleaseJson();
        final data = qualityEvaluationsJson();
        ((data['runs'] as List).single as Map)['suite'] = suite;
        return data;
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
          home: TickerMode(enabled: shown, child: const NativeQualityPage()),
        ),
      );
      await tester.pumpWidget(app(true));
      await tester.pumpAndSettle();
      await tester.ensureVisible(
        find.byKey(const ValueKey('quality-run-eval-run-1')),
      );
      await tester.tap(find.byKey(const ValueKey('quality-run-eval-run-1')));
      await tester.pumpAndSettle();
      expect(find.text('Evidence detail'), findsOneWidget);
      expect(find.text('Private prior suite'), findsWidgets);
      suite = 'Fresh replacement suite';
      container.invalidate(qualityRepositoryProvider);
      await tester.pumpAndSettle();
      expect(find.text('Private prior suite'), findsNothing);
      expect(find.text('Evidence detail'), findsNothing);
      expect(find.text('Fresh replacement suite'), findsOneWidget);
      final before = api.paths.length;
      await tester.pumpWidget(app(false));
      await tester.pumpAndSettle();
      expect(find.text('Fresh replacement suite'), findsNothing);
      suite = 'New visibility suite';
      await tester.pumpWidget(app(true));
      await tester.pumpAndSettle();
      expect(api.paths.length, before + 2);
      expect(find.text('New visibility suite'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'backgrounding drops private content and resumes with a new visibility read',
    (tester) async {
      final api = QualityTestApi()
        ..reader = (path) async => path == '/api/evaluations'
            ? qualityEvaluationsJson()
            : qualityReleaseJson();
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
          child: const MaterialApp(home: NativeQualityPage()),
        ),
      );
      await tester.pumpAndSettle();
      expect(api.paths, hasLength(2));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pumpAndSettle();
      expect(find.text('Core operations'), findsNothing);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(api.paths, hasLength(4));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
