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
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_controller.dart';
import 'package:asael/features/integrations/connector_credential_removal_contracts.dart';
import 'package:asael/features/integrations/connector_credential_removal_controller.dart';
import 'package:asael/features/integrations/connector_credential_removal_providers.dart';
import 'package:asael/features/integrations/connector_credential_removal_repository.dart';
import 'package:asael/features/integrations/connector_credential_removal_view.dart';
import 'package:asael/features/integrations/connector_providers.dart';
import 'package:asael/features/integrations/connector_view.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_credential_removal_fixtures.dart';
import 'connector_fixtures.dart';

NativeWorkspaceAccess _access(_Api api, {bool Function()? current}) =>
    NativeWorkspaceAccess(
      api,
      NativeRequestAuthority(
        tenantId: connectorOwner.tenantId,
        actorId: connectorOwner.actorId,
        canonicalUserId: connectorOwner.userId,
        role: connectorOwner.role,
        apiBaseUrl: connectorOwner.apiBaseUrl,
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
  String get apiBaseUrl => connectorOwner.apiBaseUrl;
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
    return (await removalReviewFixture()).raw;
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
    tenantId: connectorOwner.tenantId,
    actorId: connectorOwner.actorId,
    userId: connectorOwner.userId,
    email: connectorOwner.actorId,
    displayName: 'Credential owner',
    workspaceName: 'Connector workspace',
    role: connectorOwner.role,
  );
}

class _NoSessionEffects extends Fake implements SessionRepository {}

class _HeldStore extends MemorySpecialistRecoveryStore {
  final readGate = Completer<SpecialistJson?>();
  @override
  Future<SpecialistJson?> read(SpecialistOwner owner, String project) =>
      readGate.future;
}

class _MissingConnectorRepository extends ConnectorFixtureRepository {
  @override
  Future<ConnectorInventory> list() async =>
      const ConnectorInventory([], false);
  @override
  Future<ConnectorReview> review(String kind, String id) async =>
      ConnectorReview.parse(
        await connectorEnvelope({'review': null}, 'review'),
        owner,
        kind,
        id,
      );
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
        final repository = ApiConnectorCredentialRemovalRepository(
          _access(api),
        );
        final controller = ConnectorCredentialRemovalController(
          repository,
          RemovalFixtureStore(),
          'mcp:one',
        );
        final review = await removalReviewFixture();
        final intent = await ConnectorCredentialRemovalIntent.prepare(
          connectorOwner,
          review,
        );
        controller.reviewed = review;
        controller.loaded = true;
        controller.pending = ConnectorCredentialRemovalPending(
          intent,
          dispatched: true,
        );
        controller.accepted = ConnectorCredentialRemovalSavedAction(
          intent,
          await removalActionFixture(intent, settled: false),
          connectorOwner,
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
                body: ConnectorCredentialRemovalPanel(controller: controller),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        // The retained preparation and receipt precede this private review in a
        // lazy list. Make the actual review visible before testing its removal.
        await tester.scrollUntilVisible(
          find.text('Reviewed tools'),
          200,
          scrollable: find.byType(Scrollable).first,
        );
        expect(find.textContaining('Reviewed tools'), findsWidgets);
        expect(find.textContaining('mcp:one'), findsWidgets);
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
        expect(find.textContaining('Reviewed tools'), findsNothing);
        expect(find.textContaining('mcp:one'), findsNothing);
        expect(
          find.text(
            'Return to the unlocked workspace to review this credential.',
          ),
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
      final repository = ApiConnectorCredentialRemovalRepository(
        _access(api, current: () => allowed),
      );
      expect(repository.current, isTrue);
      allowed = false;
      expect(repository.current, isFalse);
      allowed = true;
      await expectLater(repository.review('mcp:one'), throwsFormatException);
      expect(api.reads, 0);
    },
  );

  test('repository disposal inside a successful access probe prevents HTTP admission', () async {
    final api = _Api();
    late ApiConnectorCredentialRemovalRepository repository;
    repository = ApiConnectorCredentialRemovalRepository(
      _access(
        api,
        current: () {
          repository.close();
          return true;
        },
      ),
    );
    await expectLater(repository.review('mcp:one'), throwsFormatException);
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
        connectorCredentialRemovalControllerProvider('mcp:one'),
        (_, _) {},
      );
      addTearDown(subscription.close);
      final outgoing = container.read(
        connectorCredentialRemovalControllerProvider('mcp:one'),
      )!;
      probe = () {
        probe = null;
        container.invalidate(
          connectorCredentialRemovalControllerProvider('mcp:one'),
        );
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
          container.invalidate(
            connectorCredentialRemovalControllerProvider('mcp:one'),
          );
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
        () => container.read(
          connectorCredentialRemovalControllerProvider('mcp:one'),
        ),
        returnsNormally,
      );
      expect(storageReads, 0);
    },
  );

  testWidgets(
    'same-owner provider replacement clears private review and ignores late data',
    (tester) async {
      final firstRepository = RemovalFixtureRepository();
      final first = ConnectorCredentialRemovalController(
        firstRepository,
        RemovalFixtureStore(),
        'mcp:one',
      );
      await first.initialize();
      var current = first;
      final container = ProviderContainer(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
          connectorCredentialRemovalControllerProvider('mcp:one')
              .overrideWith((ref) {
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
          child: const MaterialApp(
            home: NativeConnectorCredentialRemovalWorkspace(
              connectorId: 'mcp:one',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Reviewed tools'), findsOneWidget);
      final gate = Completer<ConnectorReview>();
      firstRepository.reviewGate = gate;
      final held = first.refresh();

      final nextRepository = RemovalFixtureRepository()
        ..reviewGate = (Completer<ConnectorReview>()
          ..complete(await removalReviewFixture(name: 'Replacement tools')));
      current = ConnectorCredentialRemovalController(
        nextRepository,
        RemovalFixtureStore(),
        'mcp:one',
      );
      await current.initialize();
      container.invalidate(
        connectorCredentialRemovalControllerProvider('mcp:one'),
      );
      expect(first.current, isFalse);
      gate.complete(await removalReviewFixture(name: 'Late tools'));
      await held;
      await tester.pumpAndSettle();
      expect(find.text('Replacement tools'), findsOneWidget);
      expect(find.text('Reviewed tools'), findsNothing);
      expect(find.text('Late tools'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'hiding and restoring the outer route cancels a confirmed preflight',
    (tester) async {
      final repository = RemovalFixtureRepository(),
          store = RemovalFixtureStore();
      final controller = ConnectorCredentialRemovalController(
        repository,
        store,
        'mcp:one',
      );
      await controller.initialize();
      final navigator = GlobalKey<NavigatorState>();
      final container = ProviderContainer(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
          connectorCredentialRemovalControllerProvider('mcp:one')
              .overrideWith((ref) {
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
            home: const NativeConnectorCredentialRemovalWorkspace(
              connectorId: 'mcp:one',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Remove saved credential'));
      await tester.tap(find.text('Remove saved credential'));
      await tester.pumpAndSettle();
      final gate = Completer<ConnectorReview>();
      repository.reviewGate = gate;
      await tester.tap(find.text('Confirm removal'));
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
      gate.complete(await removalReviewFixture());
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
    final repository = RemovalFixtureRepository(),
        store = RemovalFixtureStore();
    final controller = ConnectorCredentialRemovalController(
      repository,
      store,
      'mcp:one',
    );
    await controller.initialize();
    final visible = ValueNotifier(true);
    addTearDown(visible.dispose);
    final container = ProviderContainer(
      overrides: [
        nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
        connectorCredentialRemovalControllerProvider('mcp:one')
            .overrideWith((ref) {
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
          child: const MaterialApp(
            home: NativeConnectorCredentialRemovalWorkspace(
              connectorId: 'mcp:one',
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Remove saved credential'));
    await tester.tap(find.text('Remove saved credential'));
    await tester.pumpAndSettle();
    visible.value = false;
    await tester.pump();
    visible.value = true;
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm removal'));
    await tester.pumpAndSettle();
    expect(repository.posts, 0);
    expect(store.writes, 0);
    expect(controller.pending, isNull);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  for (final hideOuterRoute in [false, true]) {
    testWidgets(
      hideOuterRoute
          ? 'outer route hiding while the confirmation is open retires its authority'
          : 'explicit confirmation removes the exact local credential and shows provider-token boundary',
      (tester) async {
        final repository = RemovalFixtureRepository(),
            store = RemovalFixtureStore();
        final controller = ConnectorCredentialRemovalController(
          repository,
          store,
          'mcp:one',
        );
        await controller.initialize();
        final navigator = GlobalKey<NavigatorState>();
        final container = ProviderContainer(
          overrides: [
            nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
            connectorCredentialRemovalControllerProvider('mcp:one')
                .overrideWith((ref) {
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
              home: const NativeConnectorCredentialRemovalWorkspace(
                connectorId: 'mcp:one',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Remove saved credential'));
        await tester.tap(find.text('Remove saved credential'));
        await tester.pumpAndSettle();
        expect(
          find.textContaining('The provider token remains valid'),
          findsWidgets,
        );
        if (hideOuterRoute) {
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
        }
        await tester.tap(find.text('Confirm removal'));
        await tester.pumpAndSettle();
        expect(repository.posts, hideOuterRoute ? 0 : 1);
        expect(controller.pending, isNull);
        if (hideOuterRoute) {
          expect(store.writes, 0);
          expect(controller.accepted, isNull);
        } else {
          expect(controller.accepted!.settled, isTrue);
          await tester.ensureVisible(find.text('Saved credential removed'));
          expect(find.text('Saved credential removed'), findsOneWidget);
          expect(
            find.textContaining(
              'Connection disabled · discovered tools cleared',
            ),
            findsOneWidget,
          );
          expect(
            find.text(
              'The provider token remains valid until you revoke it with the provider.',
            ),
            findsOneWidget,
          );
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'known missing exact target opens its protected journal and recovers without POST',
    (tester) async {
      final intent = await ConnectorCredentialRemovalIntent.prepare(
        connectorOwner,
        await removalReviewFixture(),
        key: 'deleted-target-removal',
      );
      final store = RemovalFixtureStore()
        ..value = connectorFreeze({
          'schemaVersion': 'connector-credential-removal:1',
          'pending': ConnectorCredentialRemovalPending(
            intent,
            dispatched: true,
          ).stored,
          'accepted': null,
        });
      final missing = await ConnectorReview.parse(
        await connectorEnvelope({'review': null}, 'review'),
        connectorOwner,
        'mcp',
        'mcp:one',
      );
      final repository = RemovalFixtureRepository()
        ..reviewGate = (Completer<ConnectorReview>()..complete(missing));
      final removal = ConnectorCredentialRemovalController(
        repository,
        store,
        'mcp:one',
      );
      await removal.initialize();
      final controls = ConnectorController(
        _MissingConnectorRepository(),
        ConnectorFixtureStore(),
      );
      await controls.initialize();
      final container = ProviderContainer(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
          connectorControllerProvider.overrideWith((ref) {
            ref.onDispose(controls.dispose);
            return controls;
          }),
          connectorCredentialRemovalControllerProvider('mcp:one')
              .overrideWith((ref) {
                ref.onDispose(removal.dispose);
                return removal;
              }),
        ],
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: NativeConnectorWorkspace()),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.text('No MCP or OpenAPI connections are visible.'),
        findsOneWidget,
      );
      await tester.tap(find.text('Open an exact connection'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'mcp:one');
      await tester.ensureVisible(find.text('Read exact connection'));
      await tester.tap(find.text('Read exact connection'));
      await tester.pumpAndSettle();
      expect(
        find.text('This exact connection is not currently available.'),
        findsOneWidget,
      );
      // The missing review is built near the viewport edge; its following
      // recovery action needs scrolling before it exists in the lazy list.
      await tester.scrollUntilVisible(
        find.text('Open saved credential recovery'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Open saved credential recovery'));
      await tester.pumpAndSettle();
      expect(find.text('Credential removal unconfirmed'), findsOneWidget);
      expect(find.text('Remove saved credential'), findsNothing);
      await tester.ensureVisible(find.text('Check exact receipt'));
      await tester.tap(find.text('Check exact receipt'));
      await tester.pumpAndSettle();
      expect(repository.posts, 0);
      expect(repository.gets, 1);
      expect(removal.accepted!.intent.key, intent.key);
      expect(removal.accepted!.settled, isTrue);
      expect(find.text('Saved credential removed'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
