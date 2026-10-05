import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/agents/specialist_api_client.dart';
import 'package:asael/features/agents/specialist_contracts.dart';
import 'package:asael/features/agents/specialist_recovery_store.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/google_personal_contracts.dart';
import 'package:asael/features/integrations/google_personal_controller.dart';
import 'package:asael/features/integrations/google_personal_providers.dart';
import 'package:asael/features/integrations/google_personal_repository.dart';
import 'package:asael/features/integrations/google_personal_view.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'google_personal_fixtures.dart';

NativeWorkspaceAccess _access(_Api api, {bool Function()? current}) =>
    NativeWorkspaceAccess(
      api,
      NativeRequestAuthority(
        tenantId: googleOwner.tenantId,
        actorId: googleOwner.actorId,
        canonicalUserId: googleOwner.userId,
        role: googleOwner.role,
        apiBaseUrl: googleOwner.apiBaseUrl,
        isCurrent: current ?? () => true,
      ),
      false,
    );

class _Api extends ApiClient {
  _Api()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));
  int reads = 0, posts = 0;
  Object? refusal;
  final tokens = <CancelToken>[];
  @override
  String get apiBaseUrl => googleOwner.apiBaseUrl;
  @override
  Future<ConnectorJson> getJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    ConnectorJson? query,
    CancelToken? cancelToken,
  }) async {
    authority.requireCurrent(apiBaseUrl);
    reads++;
    if (cancelToken != null) tokens.add(cancelToken);
    if (refusal != null) throw refusal!;
    return (await googleReviewFixture()).raw;
  }

  @override
  Future<ConnectorJson> postJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    ConnectorJson? data,
    ConnectorJson? headers,
  }) async {
    authority.requireCurrent(apiBaseUrl);
    posts++;
    throw StateError('Unexpected mutation');
  }
}

class _Sessions extends SessionController {
  @override
  Future<AppSession?> build() async => AppSession(
    tenantId: googleOwner.tenantId,
    actorId: googleOwner.actorId,
    userId: googleOwner.userId,
    email: googleOwner.actorId,
    displayName: 'Google account owner',
    workspaceName: 'Google workspace',
    role: googleOwner.role,
  );
}

class _NoSessionEffects extends Fake implements SessionRepository {}

class _HeldStore extends MemorySpecialistRecoveryStore {
  final readGate = Completer<SpecialistJson?>();
  @override
  Future<SpecialistJson?> read(SpecialistOwner owner, String project) =>
      readGate.future;
}

void main() {
  for (final refusal in [
    const ApiException('Access changed', statusCode: 401),
    const ApiException('Access changed', statusCode: 403),
    const NativeAuthorityVerificationException(),
  ]) {
    testWidgets(
      'authority refusal retires private state and repaints: $refusal',
      (tester) async {
        final api = _Api()..refusal = refusal;
        final repository = ApiGooglePersonalRepository(_access(api));
        final controller = GooglePersonalController(
          repository,
          GoogleFixtureStore(),
        );
        final review = await googleReviewFixture();
        final intent = await GooglePersonalIntent.prepare(
          googleOwner,
          review,
          'sync',
        );
        controller.reviewed = review;
        controller.loaded = true;
        controller.pending = GooglePersonalPending(intent, dispatched: true);
        controller.accepted = GooglePersonalSavedAction(
          intent,
          await googleActionFixture(intent, settled: false),
          googleOwner,
          mutation: true,
        );
        var repaints = 0;
        controller.addListener(() => repaints++);
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              nativeWorkspaceAccessProvider.overrideWithValue(_access(api)),
            ],
            child: MaterialApp(
              home: Scaffold(
                body: GooglePersonalControlPanel(controller: controller),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.textContaining('personal@example.test'), findsWidgets);
        await controller.refresh();
        expect(controller.current, isFalse);
        expect(controller.reviewed, isNull);
        expect(controller.pending, isNull);
        expect(controller.accepted, isNull);
        expect(api.tokens.single.isCancelled, isTrue);
        // Invalidation clears synchronously but defers its notification because
        // an authority probe can occur during build. Flush that scheduled work
        // before checking both notification delivery and the rendered surface.
        await tester.pump();
        expect(repaints, greaterThan(1));
        expect(find.textContaining('personal@example.test'), findsNothing);
        expect(
          find.text('Return to the unlocked workspace to review Google.'),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        api.refusal = null;
        await controller.refresh();
        expect(api.reads, 1);
        expect(api.posts, 0);
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      },
    );
  }

  test(
    'access changing away and back cannot revive a retired repository',
    () async {
      final api = _Api();
      var allowed = true;
      final repository = ApiGooglePersonalRepository(
        _access(api, current: () => allowed),
      );
      expect(repository.current, isTrue);
      allowed = false;
      expect(repository.current, isFalse);
      allowed = true;
      await expectLater(repository.review(), throwsFormatException);
      expect(api.reads, 0);
    },
  );

  test('repository disposal inside a successful access probe prevents HTTP admission', () async {
    final api = _Api();
    late ApiGooglePersonalRepository repository;
    repository = ApiGooglePersonalRepository(
      _access(
        api,
        current: () {
          repository.close();
          return true;
        },
      ),
    );
    await expectLater(repository.review(), throwsFormatException);
    expect(api.reads, 0);
    expect(api.posts, 0);
  });

  test(
    'provider invalidation inside access probe fences the outgoing mounted Ref',
    () async {
      final previous = FlutterError.onError, errors = <FlutterErrorDetails>[];
      FlutterError.onError = errors.add;
      addTearDown(() {
        FlutterError.onError = previous;
        expect(errors, isEmpty);
      });
      final api = _Api(), store = _HeldStore();
      void Function()? probe;
      final access = _access(
        api,
        current: () {
          probe?.call();
          return true;
        },
      );
      final container = ProviderContainer(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          sessionControllerProvider.overrideWith(_Sessions.new),
          biometricSessionLockControllerProvider.overrideWith(
            (_) => BiometricSessionLockController(_NoSessionEffects()),
          ),
          nativeWorkspaceAccessProvider.overrideWithValue(access),
          specialistRecoveryProvider.overrideWithValue(store),
        ],
      );
      addTearDown(container.dispose);
      final subscription = container.listen(
        googlePersonalControllerProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);
      final outgoing = container.read(googlePersonalControllerProvider)!;
      probe = () {
        probe = null;
        container.invalidate(googlePersonalControllerProvider);
      };
      expect(outgoing.current, isFalse);
      expect(outgoing.reviewed, isNull);
      store.readGate.complete(null);
      await outgoing.refresh();
      expect(api.reads, 0);
      expect(api.posts, 0);
    },
  );

  test(
    'construction probe disposal stops before reading the next Ref dependency',
    () {
      final previous = FlutterError.onError, errors = <FlutterErrorDetails>[];
      FlutterError.onError = errors.add;
      addTearDown(() {
        FlutterError.onError = previous;
        expect(errors, isEmpty);
      });
      late ProviderContainer container;
      var firstProbe = true, storageReads = 0;
      final access = _access(
        _Api(),
        current: () {
          if (!firstProbe) return false;
          firstProbe = false;
          container.invalidate(googlePersonalControllerProvider);
          return true;
        },
      );
      container = ProviderContainer(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(access),
          specialistRecoveryProvider.overrideWith((ref) {
            storageReads++;
            return MemorySpecialistRecoveryStore();
          }),
        ],
      );
      addTearDown(container.dispose);
      expect(
        () => container.read(googlePersonalControllerProvider),
        returnsNormally,
      );
      expect(storageReads, 0);
    },
  );

  testWidgets(
    'same-owner provider replacement clears private review and ignores late data',
    (tester) async {
      final firstRepository = GoogleFixtureRepository();
      final first = GooglePersonalController(
        firstRepository,
        GoogleFixtureStore(),
      );
      await first.initialize();
      var current = first;
      final container = ProviderContainer(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
          googlePersonalControllerProvider.overrideWith((ref) {
            final controller = current;
            ref.onDispose(controller.dispose);
            return controller;
          }),
        ],
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: NativeGooglePersonalWorkspace()),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('personal@example.test'), findsOneWidget);
      final gate = Completer<GooglePersonalRead>();
      firstRepository.reviewGate = gate;
      final held = first.refresh();

      final nextRepository = GoogleFixtureRepository()
        ..reviewGate = (Completer<GooglePersonalRead>()
          ..complete(
            await googleReviewFixture(email: 'replacement@example.test'),
          ));
      current = GooglePersonalController(nextRepository, GoogleFixtureStore());
      await current.initialize();
      container.invalidate(googlePersonalControllerProvider);
      expect(first.current, isFalse);
      gate.complete(await googleReviewFixture(email: 'late@example.test'));
      await held;
      await tester.pumpAndSettle();
      expect(find.text('replacement@example.test'), findsOneWidget);
      expect(find.text('personal@example.test'), findsNothing);
      expect(find.text('late@example.test'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'hiding and restoring the outer route cancels a confirmed preflight',
    (tester) async {
      final repository = GoogleFixtureRepository(),
          store = GoogleFixtureStore();
      final controller = GooglePersonalController(repository, store);
      await controller.initialize();
      final navigator = GlobalKey<NavigatorState>();
      final container = ProviderContainer(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
          googlePersonalControllerProvider.overrideWith((ref) {
            ref.onDispose(controller.dispose);
            return controller;
          }),
        ],
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            navigatorKey: navigator,
            home: const NativeGooglePersonalWorkspace(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sync permitted sources'));
      await tester.pumpAndSettle();
      final gate = Completer<GooglePersonalRead>();
      repository.reviewGate = gate;
      await tester.tap(find.text('Confirm action'));
      await tester.pumpAndSettle();
      unawaited(
        navigator.currentState!.push(
          MaterialPageRoute<void>(
            builder: (_) => const Scaffold(body: Text('Another route')),
          ),
        ),
      );
      await tester.pumpAndSettle();
      navigator.currentState!.pop();
      await tester.pumpAndSettle();
      gate.complete(await googleReviewFixture());
      await tester.pumpAndSettle();
      expect(repository.posts, 0);
      expect(store.writes, 0);
      expect(controller.pending, isNull);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('TickerMode hide and restore retires an open confirmation', (
    tester,
  ) async {
    final repository = GoogleFixtureRepository(), store = GoogleFixtureStore();
    final controller = GooglePersonalController(repository, store);
    await controller.initialize();
    final visible = ValueNotifier(true);
    addTearDown(visible.dispose);
    final container = ProviderContainer(
      overrides: [
        nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
        googlePersonalControllerProvider.overrideWith((ref) {
          ref.onDispose(controller.dispose);
          return controller;
        }),
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: ValueListenableBuilder<bool>(
          valueListenable: visible,
          builder: (_, value, child) =>
              TickerMode(enabled: value, child: child!),
          child: const MaterialApp(home: NativeGooglePersonalWorkspace()),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sync permitted sources'));
    await tester.pumpAndSettle();
    visible.value = false;
    await tester.pump();
    visible.value = true;
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm action'));
    await tester.pumpAndSettle();
    expect(repository.posts, 0);
    expect(store.writes, 0);
    expect(controller.pending, isNull);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
