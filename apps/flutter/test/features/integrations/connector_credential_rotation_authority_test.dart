import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/agents/specialist_api_client.dart';
import 'package:asael/features/agents/specialist_recovery_store.dart';
import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_controller.dart';
import 'package:asael/features/integrations/connector_providers.dart';
import 'package:asael/features/integrations/connector_view.dart';
import 'package:asael/features/integrations/connector_credential_rotation_contracts.dart';
import 'package:asael/features/integrations/connector_credential_rotation_controller.dart';
import 'package:asael/features/integrations/connector_credential_rotation_providers.dart';
import 'package:asael/features/integrations/connector_credential_rotation_repository.dart';
import 'package:asael/features/integrations/connector_credential_rotation_view.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_credential_removal_fixtures.dart';
import 'connector_credential_rotation_fixtures.dart';
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
    if (cancelToken != null) {
      tokens.add(cancelToken);
    }
    if (refusal != null) {
      throw refusal!;
    }
    return (await removalReviewFixture()).raw;
  }

  @override
  Future<ConnectorJson> postJsonAuthorizedOnce(
    String path, {
    required NativeRequestAuthority authority,
    ConnectorJson? data,
    ConnectorJson? headers,
    Duration? receiveTimeout,
  }) async {
    authority.requireCurrent(apiBaseUrl);
    posts++;
    throw StateError('Unexpected secret request');
  }
}

class _MissingInventory extends ConnectorFixtureRepository {
  @override
  Future<ConnectorInventory> list() async =>
      const ConnectorInventory([], false);
}

class _MissingReview extends RotationFixtureRepository {
  @override
  Future<ConnectorReview> review(String id) async => ConnectorReview.parse(
    await connectorEnvelope({'review': null}, 'review'),
    owner,
    'mcp',
    id,
  );
}

void main() {
  testWidgets(
    'empty inventory opens the protected rotation family journal and recovers the missing exact target without POST',
    (tester) async {
      final intent = await ConnectorCredentialPreparationIntent.prepare(
        connectorOwner,
        await removalReviewFixture(),
      );
      final store = RotationFixtureStore()
        ..value = connectorFreeze({
          'schemaVersion': 'connector-credential-rotation:1',
          'sequence': ConnectorCredentialRotationSequence(
            intent: intent,
            prepareDispatched: true,
          ).stored,
        });
      final repository = _MissingReview();
      final rotation = ConnectorCredentialRotationController(
        repository,
        store,
        now: () => rotationNow,
      );
      final controls = ConnectorController(
        _MissingInventory(),
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
          connectorCredentialRotationControllerProvider.overrideWith((ref) {
            ref.onDispose(rotation.dispose);
            return rotation;
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
      await tester.scrollUntilVisible(
        find.text('Credential preparation recovery'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Credential preparation recovery'));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Check exact preparation'),
        200,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.tap(find.text('Check exact preparation'));
      await tester.pumpAndSettle();
      expect(rotation.sequence!.intent.key, intent.key);
      expect(rotation.sequence!.prepared!.availability, 'ready');
      expect(repository.preparationReads, 1);
      expect(repository.prepares + repository.submits + repository.abandons, 0);
      expect(rotation.canConfirm, isFalse);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final refusal in [
    const ApiException('Refused', statusCode: 401),
    const ApiException('Refused', statusCode: 403),
    const NativeAuthorityVerificationException(),
  ]) {
    testWidgets(
      'authority refusal clears private review and journal and delivers deferred repaint: $refusal',
      (tester) async {
        var notifications = 0;
        final liveApi = _Api();
        final live = ConnectorCredentialRotationController(
          ApiConnectorCredentialRotationRepository(_access(liveApi)),
          RotationFixtureStore(),
          now: () => rotationNow,
        );
        await live.initialize();
        await live.select('mcp:one');
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: ConnectorCredentialRotationPanel(controller: live),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final safe = await ConnectorCredentialPreparationIntent.prepare(
          connectorOwner,
          live.reviewed!,
        );
        live.sequence = ConnectorCredentialRotationSequence(
          intent: safe,
          prepareDispatched: true,
        );
        live.addListener(() => notifications++);
        await tester.scrollUntilVisible(
          find.text('Reviewed tools'),
          150,
          scrollable: find.byType(Scrollable).first,
        );
        expect(find.text('Reviewed tools'), findsOneWidget);
        liveApi.refusal = refusal;
        await live.refresh();
        expect(live.reviewed, isNull);
        expect(live.sequence, isNull);
        expect(live.current, isFalse);
        expect(liveApi.tokens.every((token) => token.isCancelled), isTrue);
        await tester.pump();
        expect(notifications, greaterThan(1));
        expect(find.textContaining('Reviewed tools'), findsNothing);
        expect(find.textContaining('mcp:one'), findsNothing);
        expect(tester.takeException(), isNull);
        liveApi.refusal = null;
        final reads = liveApi.reads;
        await live.refresh();
        expect(liveApi.reads, reads);
        await tester.pumpWidget(const SizedBox());
        live.dispose();
      },
    );
  }

  test('repository disposal inside successful authority probe prevents HTTP and never revives', () async {
    final api = _Api();
    late ApiConnectorCredentialRotationRepository repo;
    repo = ApiConnectorCredentialRotationRepository(
      _access(
        api,
        current: () {
          repo.close();
          return true;
        },
      ),
    );
    await expectLater(repo.review('mcp:one'), throwsFormatException);
    expect(api.reads, 0);
    expect(repo.current, isFalse);
  });
  test('provider construction invalidation inside access probe never reads the next dependency', () {
    final previous = FlutterError.onError, errors = <FlutterErrorDetails>[];
    FlutterError.onError = errors.add;
    addTearDown(() {
      FlutterError.onError = previous;
      expect(errors, isEmpty);
    });
    late ProviderContainer container;
    var first = true, storageReads = 0;
    container = ProviderContainer(
      overrides: [
        nativeWorkspaceAccessProvider.overrideWithValue(
          _access(
            _Api(),
            current: () {
              if (!first) {
                return false;
              }
              first = false;
              container.invalidate(
                connectorCredentialRotationControllerProvider,
              );
              return true;
            },
          ),
        ),
        specialistRecoveryProvider.overrideWith((ref) {
          storageReads++;
          return MemorySpecialistRecoveryStore();
        }),
      ],
    );
    addTearDown(container.dispose);
    expect(
      () => container.read(connectorCredentialRotationControllerProvider),
      returnsNormally,
    );
    expect(storageReads, 0);
  });

  testWidgets(
    'token input clears on TickerMode hide and same-owner panel replacement',
    (tester) async {
      final repository = RotationFixtureRepository(),
          c = ConnectorCredentialRotationController(
            RotationFixtureRepository(),
            RotationFixtureStore(),
            now: () => rotationNow,
          );
      await c.initialize();
      await c.select('mcp:one');
      final visible = ValueNotifier(true);
      addTearDown(visible.dispose);
      Widget surface(ConnectorCredentialRotationController controller) =>
          MaterialApp(
            home: Scaffold(
              body: ValueListenableBuilder<bool>(
                valueListenable: visible,
                builder: (_, enabled, _) => TickerMode(
                  enabled: enabled,
                  child: ConnectorCredentialRotationPanel(
                    controller: controller,
                  ),
                ),
              ),
            ),
          );
      await tester.pumpWidget(surface(c));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byType(TextField),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.enterText(find.byType(TextField), rotationToken);
      visible.value = false;
      await tester.pump();
      visible.value = true;
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byType(TextField),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty,
      );
      await tester.enterText(find.byType(TextField), rotationToken);
      final next = ConnectorCredentialRotationController(
        repository,
        RotationFixtureStore(),
        now: () => rotationNow,
      );
      await next.initialize();
      await next.select('mcp:two');
      await tester.pumpWidget(surface(next));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byType(TextField),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty,
      );
      expect(repository.prepares, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      next.dispose();
    },
  );

  for (final hide in ['none', 'ticker', 'outer']) {
    testWidgets(
      'explicit confirmation with $hide hiding preserves the visible authority boundary',
      (tester) async {
        final repo = RotationFixtureRepository(),
            store = RotationFixtureStore();
        final c = ConnectorCredentialRotationController(
          repo,
          store,
          now: () => rotationNow,
        );
        await c.initialize();
        await c.select('mcp:one');
        await c.prepare(
          c.reviewed!,
          rotationToken,
          () => true,
          clearSecret: () {},
        );
        final visible = ValueNotifier(true),
            navigator = GlobalKey<NavigatorState>();
        addTearDown(visible.dispose);
        final container = ProviderContainer(
          overrides: [
            nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
            connectorCredentialRotationControllerProvider.overrideWith((ref) {
              ref.onDispose(c.dispose);
              return c;
            }),
          ],
        );
        addTearDown(container.dispose);
        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: ValueListenableBuilder<bool>(
              valueListenable: visible,
              builder: (_, enabled, child) =>
                  TickerMode(enabled: enabled, child: child!),
              child: MaterialApp(
                navigatorKey: navigator,
                home: const NativeConnectorCredentialRotationWorkspace(
                  connectorId: 'mcp:one',
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.text('Review and confirm credential save'),
          200,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.tap(find.text('Review and confirm credential save'));
        await tester.pumpAndSettle();
        if (hide == 'ticker') {
          visible.value = false;
          await tester.pump();
          visible.value = true;
          await tester.pumpAndSettle();
        }
        if (hide == 'outer') {
          unawaited(
            navigator.currentState!.push(
              MaterialPageRoute<void>(
                builder: (_) => const Scaffold(body: Text('Other route')),
              ),
            ),
          );
          await tester.pumpAndSettle();
          navigator.currentState!.pop();
          await tester.pumpAndSettle();
        }
        await tester.tap(find.text('Confirm credential save'));
        await tester.pumpAndSettle();
        expect(repo.submits, hide == 'none' ? 1 : 0);
        if (hide != 'none') {
          expect(c.sequence!.finalIntent, isNull);
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
