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
import 'package:asael/features/integrations/connector_mcp_registration_contracts.dart';
import 'package:asael/features/integrations/connector_mcp_registration_controller.dart';
import 'package:asael/features/integrations/connector_mcp_registration_providers.dart';
import 'package:asael/features/integrations/connector_mcp_registration_repository.dart';
import 'package:asael/features/integrations/connector_mcp_registration_view.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_mcp_registration_fixtures.dart';
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
    throw StateError('Unexpected read');
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
    if (refusal != null) {
      throw refusal!;
    }
    throw StateError('Lost synthetic preparation reply');
  }
}

class _MissingInventory extends ConnectorFixtureRepository {
  @override
  Future<ConnectorInventory> list() async =>
      const ConnectorInventory([], false);
}

void main() {
  testWidgets(
    'empty inventory opens the protected registration family journal and recovers its derived target without POST',
    (tester) async {
      final intent = await ConnectorMcpRegistrationPreparationIntent.prepare(
        connectorOwner,
        registrationDeclaration(),
      );
      final store = RegistrationFixtureStore()
        ..value = connectorFreeze({
          'schemaVersion': 'connector-mcp-registration:1',
          'sequence': ConnectorMcpRegistrationSequence(
            intent: intent,
            prepareDispatched: true,
          ).stored,
        });
      final repository = RegistrationFixtureRepository();
      final registration = ConnectorMcpRegistrationController(
        repository,
        store,
        now: () => registrationNow,
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
          connectorMcpRegistrationControllerProvider.overrideWith((ref) {
            ref.onDispose(registration.dispose);
            return registration;
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
        find.text('MCP registration recovery'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('MCP registration recovery'));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Check exact preparation'),
        200,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.tap(find.text('Check exact preparation'));
      await tester.pumpAndSettle();
      expect(registration.sequence!.intent.key, intent.key);
      expect(registration.sequence!.prepared!.availability, 'ready');
      expect(repository.preparationReads, 1);
      expect(repository.prepares + repository.submits + repository.abandons, 0);
      expect(registration.canConfirm, isTrue);
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
      'authority refusal clears private declaration and journal and delivers deferred repaint: $refusal',
      (tester) async {
        var notifications = 0;
        final liveApi = _Api();
        final live = ConnectorMcpRegistrationController(
          ApiConnectorMcpRegistrationRepository(_access(liveApi)),
          RegistrationFixtureStore(),
          now: () => registrationNow,
        );
        final safe = await ConnectorMcpRegistrationPreparationIntent.prepare(
          connectorOwner,
          registrationDeclaration(),
        );
        (live.store as RegistrationFixtureStore).value = connectorFreeze({
          'schemaVersion': 'connector-mcp-registration:1',
          'sequence': ConnectorMcpRegistrationSequence(
            intent: safe,
            prepareDispatched: true,
          ).stored,
        });
        await live.initialize();
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: ConnectorMcpRegistrationPanel(controller: live),
            ),
          ),
        );
        await tester.pumpAndSettle();
        live.addListener(() => notifications++);
        await tester.scrollUntilVisible(
          find.text('Synthetic MCP setup'),
          150,
          scrollable: find.byType(Scrollable).first,
        );
        expect(find.text('Synthetic MCP setup'), findsOneWidget);
        liveApi.refusal = refusal;
        await live.recover();
        expect(live.sequence, isNull);
        expect(live.current, isFalse);
        expect(liveApi.tokens.every((token) => token.isCancelled), isTrue);
        await tester.pump();
        expect(notifications, greaterThan(1));
        expect(find.textContaining('Synthetic MCP setup'), findsNothing);
        expect(find.textContaining(safe.id), findsNothing);
        expect(tester.takeException(), isNull);
        liveApi.refusal = null;
        final reads = liveApi.reads;
        await live.recover();
        expect(liveApi.reads, reads);
        await tester.pumpWidget(const SizedBox());
        live.dispose();
      },
    );
  }

  test('repository disposal inside successful authority probe prevents HTTP and never revives', () async {
    final api = _Api();
    late ApiConnectorMcpRegistrationRepository repo;
    repo = ApiConnectorMcpRegistrationRepository(
      _access(
        api,
        current: () {
          repo.close();
          return true;
        },
      ),
    );
    final intent = await ConnectorMcpRegistrationPreparationIntent.prepare(
      connectorOwner,
      registrationDeclaration(),
    );
    await expectLater(repo.readPreparation(intent), throwsFormatException);
    expect(api.reads, 0);
    expect(repo.current, isFalse);
  });
  for (final auth in ['none', 'bearer_env', 'bearer_vault']) {
    test(
      '$auth preparation uses the one-shot transient transport and latches 401',
      () async {
        final api = _Api()
          ..refusal = const ApiException('Refused', statusCode: 401);
        final repo = ApiConnectorMcpRegistrationRepository(_access(api));
        final intent = await ConnectorMcpRegistrationPreparationIntent.prepare(
          connectorOwner,
          registrationDeclaration(authType: auth),
        );
        await expectLater(
          repo.prepare(
            intent,
            registrationEndpoint,
            auth == 'bearer_vault' ? registrationToken : null,
            () => true,
          ),
          throwsA(isA<ApiException>()),
        );
        expect(api.posts, 1);
        expect(repo.current, isFalse);
        await expectLater(
          repo.prepare(
            intent,
            registrationEndpoint,
            auth == 'bearer_vault' ? registrationToken : null,
            () => true,
          ),
          throwsFormatException,
        );
        expect(api.posts, 1);
        expect(api.reads, 0);
      },
    );
  }

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
              container.invalidate(connectorMcpRegistrationControllerProvider);
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
      () => container.read(connectorMcpRegistrationControllerProvider),
      returnsNormally,
    );
    expect(storageReads, 0);
  });

  testWidgets(
    'new MCP form keeps safe defaults and creation requires its separate fresh confirmation',
    (tester) async {
      final repository = RegistrationFixtureRepository(),
          store = RegistrationFixtureStore();
      final c = ConnectorMcpRegistrationController(
        repository,
        store,
        now: () => registrationNow,
      );
      await c.initialize();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
          ],
          child: MaterialApp(
            home: Scaffold(body: ConnectorMcpRegistrationPanel(controller: c)),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Finder field(String label) => find.byWidgetPredicate(
        (widget) =>
            widget is TextField && widget.decoration?.labelText == label,
      );
      Future<void> show(Finder finder) async {
        await tester.scrollUntilVisible(
          finder,
          200,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pumpAndSettle();
      }

      await show(field('Connection name'));
      await tester.enterText(field('Connection name'), 'Local MCP setup');
      await show(field('Full MCP endpoint'));
      await tester.enterText(field('Full MCP endpoint'), registrationEndpoint);
      final endpoint = tester
          .widget<TextField>(field('Full MCP endpoint'))
          .controller!;
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      final prepare = find.widgetWithText(
        FilledButton,
        'Prepare new MCP connection',
      );
      await show(prepare);
      await Scrollable.ensureVisible(tester.element(prepare), alignment: 0.5);
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(prepare).onPressed, isNotNull);
      expect(prepare.hitTestable(), findsOneWidget);
      await tester.tap(prepare.hitTestable());
      await tester.pumpAndSettle();
      expect(endpoint.text, isEmpty);
      expect(repository.prepares, 1);
      expect(repository.submits, 0);
      expect(c.sequence!.intent.declaration['authType'], 'none');
      expect(c.sequence!.intent.declaration['defaultRiskLevel'], 2);
      expect(c.sequence!.intent.declaration['approvalRequired'], isTrue);
      // Preparing shortens the page, so return to the receipt before confirming.
      await tester.drag(find.byType(ListView).first, const Offset(0, 1200));
      await tester.pumpAndSettle();
      await show(find.text('Review and confirm creation'));
      await tester.tap(find.text('Review and confirm creation'));
      await tester.pumpAndSettle();
      expect(repository.preparationReads, 1);
      expect(repository.submits, 0);
      expect(find.text('Create this disabled MCP connection?'), findsOneWidget);
      await tester.tap(find.text('Confirm MCP creation'));
      await tester.pumpAndSettle();
      expect(repository.preparationReads, 2);
      expect(repository.submits, 1);
      expect(c.sequence!.action!.settled, isTrue);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    },
  );

  testWidgets(
    'endpoint and token clear on hide and same-owner panel replacement',
    (tester) async {
      final c = ConnectorMcpRegistrationController(
        RegistrationFixtureRepository(),
        RegistrationFixtureStore(),
        now: () => registrationNow,
      );
      await c.initialize();
      final visible = ValueNotifier(true);
      addTearDown(visible.dispose);
      final access = _access(_Api());
      Widget surface(
        ConnectorMcpRegistrationController controller,
      ) => ProviderScope(
        overrides: [nativeWorkspaceAccessProvider.overrideWithValue(access)],
        child: MaterialApp(
          home: Scaffold(
            body: ValueListenableBuilder<bool>(
              valueListenable: visible,
              builder: (_, enabled, _) => TickerMode(
                enabled: enabled,
                child: ConnectorMcpRegistrationPanel(controller: controller),
              ),
            ),
          ),
        ),
      );
      Finder field(String label) => find.byWidgetPredicate(
        (widget) =>
            widget is TextField && widget.decoration?.labelText == label,
      );
      Future<void> show(Finder finder) => tester.scrollUntilVisible(
        finder,
        180,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpWidget(surface(c));
      await tester.pumpAndSettle();
      await show(field('Full MCP endpoint'));
      await tester.enterText(field('Full MCP endpoint'), registrationEndpoint);
      final endpoint = tester
          .widget<TextField>(field('Full MCP endpoint'))
          .controller!;
      await show(find.text('No authentication'));
      await tester.tap(find.text('No authentication'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Saved bearer token').last);
      await tester.pumpAndSettle();
      await show(field('Bearer token'));
      await tester.enterText(field('Bearer token'), registrationToken);
      final token = tester.widget<TextField>(field('Bearer token')).controller!;
      visible.value = false;
      await tester.pump();
      expect(endpoint.text, isEmpty);
      expect(token.text, isEmpty);
      visible.value = true;
      await tester.pumpAndSettle();
      endpoint.text = registrationEndpoint;
      token.text = registrationToken;
      final next = ConnectorMcpRegistrationController(
        RegistrationFixtureRepository(),
        RegistrationFixtureStore(),
        now: () => registrationNow,
      );
      await next.initialize();
      await tester.pumpWidget(surface(next));
      await tester.pumpAndSettle();
      expect(endpoint.text, isEmpty);
      expect(token.text, isEmpty);
      expect(next.sequence, isNull);
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
        final repo = RegistrationFixtureRepository(),
            store = RegistrationFixtureStore();
        final c = ConnectorMcpRegistrationController(
          repo,
          store,
          now: () => registrationNow,
        );
        await c.initialize();
        await c.prepare(
          registrationDeclaration(),
          registrationEndpoint,
          registrationToken,
          () => true,
          clearSecret: () {},
        );
        final visible = ValueNotifier(true),
            navigator = GlobalKey<NavigatorState>();
        addTearDown(visible.dispose);
        final container = ProviderContainer(
          overrides: [
            nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
            connectorMcpRegistrationControllerProvider.overrideWith((ref) {
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
                home: const NativeConnectorMcpRegistrationWorkspace(),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.text('Review and confirm creation'),
          200,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.tap(find.text('Review and confirm creation'));
        await tester.pumpAndSettle();
        expect(repo.preparationReads, 1);
        expect(repo.submits, 0);
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
        await tester.tap(find.text('Confirm MCP creation'));
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
