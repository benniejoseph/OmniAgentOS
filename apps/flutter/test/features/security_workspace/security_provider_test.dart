import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/security/security_controller.dart';
import 'package:asael/features/security/security_providers.dart';
import 'package:asael/features/security/security_workspace_view.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'security_test_support.dart';

AppSession _session({
  String tenant = 'tenant-a',
  String actor = 'owner@example.test',
  String user = securityUser,
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

class _MutableOriginApi extends SecurityTestApi {
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
      '$change replacement clears outgoing Security before provider rebuild',
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
        final provider = securityControllerProvider('visible'),
            subscription = container.listen(
              securityControllerProvider('visible'),
              (_, _) {},
            );
        addTearDown(subscription.close);
        final c = container.read(provider)!;
        final repository = container.read(securityRepositoryProvider)!;
        await c.refresh();
        for (final source in SecuritySource.values) {
          expect(c.lane(source).data, isNotNull);
          expect(c.lane(source).receivedAt, isNotNull);
        }
        final selectedId = c.context.data!.rules.first.action;
        c.select(selectedId);
        final held = Completer<Map<String, dynamic>>();
        api.reader = (_) => held.future;
        final pending = c.refreshSource(SecuritySource.retention);
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
            container.invalidate(securityRepositoryProvider);
        }
        expect(c.available, isFalse);
        for (final source in SecuritySource.values) {
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
          await expectLater(
            repository.context(CancelToken()),
            throwsStateError,
          );
        }
        held.complete(securityRetentionJson());
        await pending;
        await c.refresh();
        expect(original.paths, hasLength(5));
        expect(c.retention.data, isNull);
      },
    );
  }
  testWidgets(
    'same-owner repository replacement and hidden return discard old inspector content',
    (tester) async {
      tester.view.physicalSize = const Size(900, 1200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = SecurityTestApi();
      var description = 'Prior private rule';
      api.reader = (path) async {
        final json = securityResponse(path);
        if (path == '/api/security/context') {
          (((json['policy'] as Map)['rbacRules'] as List).first
                  as Map)['description'] =
              description;
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
          home: TickerMode(enabled: shown, child: const NativeSecurityPage()),
        ),
      );
      await tester.pumpWidget(app(true));
      await tester.pumpAndSettle();
      final row = find.byKey(const ValueKey('security-rule-read.security'));
      await tester.scrollUntilVisible(
        row,
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(row);
      await tester.pumpAndSettle();
      expect(find.text('Evidence detail'), findsOneWidget);
      description = 'Fresh private rule';
      container.invalidate(securityRepositoryProvider);
      await tester.pumpAndSettle();
      expect(find.text('Prior private rule'), findsNothing);
      expect(find.text('Evidence detail'), findsNothing);
      final before = api.paths.length;
      await tester.pumpWidget(app(false));
      await tester.pumpAndSettle();
      expect(find.text('Fresh private rule'), findsNothing);
      description = 'New visibility rule';
      await tester.pumpWidget(app(true));
      await tester.pumpAndSettle();
      expect(api.paths.length, before + 4);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets(
    'backgrounding clears evidence and resumes with four fresh GETs',
    (tester) async {
      final api = SecurityTestApi();
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
          child: const MaterialApp(home: NativeSecurityPage()),
        ),
      );
      await tester.pumpAndSettle();
      expect(api.paths, hasLength(4));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pumpAndSettle();
      expect(find.text('Security evidence'), findsNothing);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(api.paths, hasLength(8));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
