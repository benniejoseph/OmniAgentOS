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
import 'package:asael/features/integrations/connector_trash_contracts.dart';
import 'package:asael/features/integrations/connector_trash_controller.dart';
import 'package:asael/features/integrations/connector_trash_providers.dart';
import 'package:asael/features/integrations/connector_trash_repository.dart';
import 'package:asael/features/integrations/connector_trash_view.dart';
import 'package:asael/features/integrations/connector_providers.dart';
import 'package:asael/features/integrations/connector_view.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_trash_fixtures.dart';
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
        final repository = ApiConnectorTrashRepository(_access(api));
        final controller = ConnectorTrashController(
          repository,
          TrashFixtureStore(),
          now: () => trashNow,
        );
        await controller.initialize();
        controller.selectedId = 'mcp:one';
        final review = await trashPreviewFixture();
        final intent = await ConnectorTrashIntent.prepare(
          connectorOwner,
          review,
          now: trashNow,
        );
        controller.reviewed = review;
        controller.loaded = true;
        controller.pending = ConnectorTrashPending(intent, dispatched: true);
        controller.accepted = ConnectorTrashSavedAction(
          intent,
          await trashActionFixture(intent, settled: false),
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
              home: Scaffold(body: ConnectorTrashPanel(controller: controller)),
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
            'Return to the unlocked workspace to review connector Trash.',
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
      final repository = ApiConnectorTrashRepository(
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
    late ApiConnectorTrashRepository repository;
    repository = ApiConnectorTrashRepository(
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
        connectorTrashControllerProvider,
        (_, _) {},
      );
      addTearDown(subscription.close);
      final outgoing = container.read(connectorTrashControllerProvider)!;
      probe = () {
        probe = null;
        container.invalidate(connectorTrashControllerProvider);
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
          container.invalidate(connectorTrashControllerProvider);
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
        () => container.read(connectorTrashControllerProvider),
        returnsNormally,
      );
      expect(storageReads, 0);
    },
  );

  testWidgets(
    'same-owner provider replacement clears private review and ignores late data',
    (tester) async {
      final firstRepository = TrashFixtureRepository();
      final first = ConnectorTrashController(
        firstRepository,
        TrashFixtureStore(),
        now: () => trashNow,
      );
      await first.initialize();
      var current = first;
      final container = ProviderContainer(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
          connectorTrashControllerProvider.overrideWith((ref) {
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
            home: NativeConnectorTrashWorkspace(connectorId: 'mcp:one'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Reviewed tools'), findsOneWidget);
      final gate = Completer<ConnectorTrashPreview>();
      firstRepository.previewGate = gate;
      final held = first.refresh();

      final nextRepository = TrashFixtureRepository()
        ..previewGate = (Completer<ConnectorTrashPreview>()
          ..complete(await trashPreviewFixture(name: 'Replacement tools')));
      current = ConnectorTrashController(
        nextRepository,
        TrashFixtureStore(),
        now: () => trashNow,
      );
      await current.initialize();
      container.invalidate(connectorTrashControllerProvider);
      expect(first.current, isFalse);
      gate.complete(await trashPreviewFixture(name: 'Late tools'));
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
      final repository = TrashFixtureRepository(), store = TrashFixtureStore();
      final controller = ConnectorTrashController(
        repository,
        store,
        now: () => trashNow,
      );
      await controller.initialize();
      final navigator = GlobalKey<NavigatorState>();
      final container = ProviderContainer(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
          connectorTrashControllerProvider.overrideWith((ref) {
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
            home: const NativeConnectorTrashWorkspace(connectorId: 'mcp:one'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Move to Trash'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Move to Trash'));
      await tester.pumpAndSettle();
      final gate = Completer<ConnectorReview>();
      repository.reviewGate = gate;
      await tester.tap(find.text('Confirm move to Trash'));
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
    final repository = TrashFixtureRepository(), store = TrashFixtureStore();
    final controller = ConnectorTrashController(
      repository,
      store,
      now: () => trashNow,
    );
    await controller.initialize();
    final visible = ValueNotifier(true);
    addTearDown(visible.dispose);
    final container = ProviderContainer(
      overrides: [
        nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
        connectorTrashControllerProvider.overrideWith((ref) {
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
            home: NativeConnectorTrashWorkspace(connectorId: 'mcp:one'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('Move to Trash'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Move to Trash'));
    await tester.pumpAndSettle();
    visible.value = false;
    await tester.pump();
    visible.value = true;
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm move to Trash'));
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
          : 'explicit confirmation moves the exact connection and shows historical browser recovery',
      (tester) async {
        final repository = TrashFixtureRepository(),
            store = TrashFixtureStore();
        final controller = ConnectorTrashController(
          repository,
          store,
          now: () => trashNow,
        );
        await controller.initialize();
        final navigator = GlobalKey<NavigatorState>();
        final container = ProviderContainer(
          overrides: [
            nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
            connectorTrashControllerProvider.overrideWith((ref) {
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
              home: const NativeConnectorTrashWorkspace(connectorId: 'mcp:one'),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.text('Move to Trash'),
          200,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.tap(find.text('Move to Trash'));
        await tester.pumpAndSettle();
        expect(
          find.textContaining('It does not revoke the provider token'),
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
        await tester.tap(find.text('Confirm move to Trash'));
        await tester.pumpAndSettle();
        expect(repository.posts, hideOuterRoute ? 0 : 1);
        expect(controller.pending, isNull);
        if (hideOuterRoute) {
          expect(store.writes, 0);
          expect(controller.accepted, isNull);
        } else {
          expect(controller.accepted!.settled, isTrue);
          await tester.scrollUntilVisible(
            find.text('Move to Trash confirmed'),
            -200,
            scrollable: find.byType(Scrollable).first,
          );
          expect(find.text('Move to Trash confirmed'), findsOneWidget);
          expect(find.text('Trash ID: $trashId'), findsOneWidget);
          expect(
            find.textContaining(
              'does not establish current restore availability',
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
    'expiry while explicit confirmation is open requires a newly reviewed preview',
    (tester) async {
      var now = trashNow;
      final repository = TrashFixtureRepository(), store = TrashFixtureStore();
      final controller = ConnectorTrashController(
        repository,
        store,
        now: () => now,
      );
      final container = ProviderContainer(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
          connectorTrashControllerProvider.overrideWith((ref) {
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
            home: NativeConnectorTrashWorkspace(connectorId: 'mcp:one'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Move to Trash'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Move to Trash'));
      await tester.pumpAndSettle();
      now = trashNow.add(const Duration(minutes: 10));
      await tester.tap(find.text('Confirm move to Trash'));
      await tester.pumpAndSettle();
      expect(repository.posts, 0);
      expect(repository.previewReads, 1);
      expect(repository.reviewReads, 0);
      expect(store.writes, 0);
      expect(controller.canAct, isFalse);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'empty inventory opens the owner Trash journal and recovers a deleted target by exact GET',
    (tester) async {
      final intent = await ConnectorTrashIntent.prepare(
        connectorOwner,
        await trashPreviewFixture(),
        now: trashNow,
        key: 'deleted-target-trash',
      );
      final store = TrashFixtureStore()
        ..value = connectorFreeze({
          'schemaVersion': 'connector-trash:1',
          'pending': ConnectorTrashPending(intent, dispatched: true).stored,
          'accepted': null,
        });
      final repository = TrashFixtureRepository();
      final trash = ConnectorTrashController(
        repository,
        store,
        now: () => trashNow.add(const Duration(days: 100)),
      );
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
          connectorTrashControllerProvider.overrideWith((ref) {
            ref.onDispose(trash.dispose);
            return trash;
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
      await tester.tap(find.text('Connector Trash recovery'));
      await tester.pumpAndSettle();
      expect(find.text('Move to Trash unconfirmed'), findsOneWidget);
      expect(find.text('Move to Trash'), findsNothing);
      await tester.scrollUntilVisible(
        find.text('Check exact receipt'),
        150,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Check exact receipt'));
      await tester.pumpAndSettle();
      expect(repository.posts, 0);
      expect(repository.gets, 1);
      expect(repository.previewReads, 0);
      expect(repository.reviewReads, 0);
      expect(trash.accepted!.intent.key, intent.key);
      expect(find.text('Move to Trash confirmed'), findsOneWidget);
      expect(
        find.widgetWithText(SelectableText, 'Trash ID: $trashId'),
        findsOneWidget,
      );
      expect(
        find.textContaining('does not establish current restore availability'),
        findsOneWidget,
      );
      await tester.scrollUntilVisible(
        find.text('Open Trash recovery in browser'),
        150,
        scrollable: find.byType(Scrollable).first,
      );
      final handoff = tester.widget<NativeWorkspaceBrowserButton>(
        find.byType(NativeWorkspaceBrowserButton),
      );
      expect(handoff.path, '/app/settings');
      await tester.scrollUntilVisible(
        find.text('Receipt details'),
        150,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Receipt details'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(repository.posts, 0);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
