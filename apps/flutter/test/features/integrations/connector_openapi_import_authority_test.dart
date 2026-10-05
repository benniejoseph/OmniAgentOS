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
import 'package:asael/features/integrations/connector_openapi_import_contracts.dart';
import 'package:asael/features/integrations/connector_openapi_import_controller.dart';
import 'package:asael/features/integrations/connector_openapi_import_providers.dart';
import 'package:asael/features/integrations/connector_openapi_import_repository.dart';
import 'package:asael/features/integrations/connector_openapi_import_view.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_openapi_import_fixtures.dart';
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
  Duration? timeout;
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
    timeout = receiveTimeout;
    if (refusal != null) {
      throw refusal!;
    }
    throw StateError('Lost synthetic preparation reply');
  }
}

class _MissingInventory extends ConnectorFixtureRepository {
  final reviewed = <({String kind, String id})>[];
  @override
  Future<ConnectorInventory> list() async =>
      const ConnectorInventory([], false);
  @override
  Future<ConnectorReview> review(String kind, String id) {
    reviewed.add((kind: kind, id: id));
    return super.review(kind, id);
  }
}

void main() {
  testWidgets(
    'settled import opens exact target review even when inventory is empty',
    (tester) async {
      final store = ImportFixtureStore();
      final first = ConnectorOpenApiImportController(
        ImportFixtureRepository(),
        store,
        now: () => importNow,
      );
      await first.initialize();
      await first.prepare(
        importDeclaration(),
        importPayload(),
        () => true,
        clearSecret: () {},
      );
      await first.confirm(first.sequence!, () => true);
      final target = first.sequence!.intent.id;
      first.dispose();
      final repository = ImportFixtureRepository();
      final importing = ConnectorOpenApiImportController(
        repository,
        store,
        now: () => importNow,
      );
      final inventory = _MissingInventory();
      final controls = ConnectorController(inventory, ConnectorFixtureStore());
      await controls.initialize();
      final container = ProviderContainer(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
          connectorControllerProvider.overrideWith((ref) {
            ref.onDispose(controls.dispose);
            return controls;
          }),
          connectorOpenApiImportControllerProvider.overrideWith((ref) {
            ref.onDispose(importing.dispose);
            return importing;
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
        find.text('OpenAPI import recovery'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('OpenAPI import recovery').hitTestable());
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Review imported connection'),
        200,
        scrollable: find.byType(Scrollable).last,
      );
      await Scrollable.ensureVisible(
        tester.element(find.text('Review imported connection')),
        alignment: 0.5,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Review imported connection').hitTestable());
      await tester.pumpAndSettle();
      expect(inventory.reviewed, [(kind: 'openapi', id: target)]);
      expect(controls.selectedKind, 'openapi');
      expect(controls.selectedId, target);
      expect(repository.prepares + repository.submits + repository.abandons, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'empty inventory opens the protected import family journal and recovers its derived target without POST',
    (tester) async {
      final intent = await ConnectorOpenApiImportPreparationIntent.prepare(
        connectorOwner,
        importDeclaration(),
      );
      final store = ImportFixtureStore()
        ..value = connectorFreeze({
          'schemaVersion': 'connector-openapi-import:1',
          'sequence': ConnectorOpenApiImportSequence(
            intent: intent,
            prepareDispatched: true,
          ).stored,
        });
      final repository = ImportFixtureRepository();
      final import = ConnectorOpenApiImportController(
        repository,
        store,
        now: () => importNow,
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
          connectorOpenApiImportControllerProvider.overrideWith((ref) {
            ref.onDispose(import.dispose);
            return import;
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
        find.text('OpenAPI import recovery'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      expect(
        find.text('OpenAPI import recovery').hitTestable(),
        findsOneWidget,
      );
      await tester.tap(find.text('OpenAPI import recovery').hitTestable());
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Check exact preparation'),
        200,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.pumpAndSettle();
      await Scrollable.ensureVisible(
        tester.element(find.text('Check exact preparation')),
        alignment: 0.5,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Check exact preparation').hitTestable());
      await tester.pumpAndSettle();
      expect(import.sequence!.intent.key, intent.key);
      expect(import.sequence!.prepared!.availability, 'ready');
      expect(repository.preparationReads, 1);
      expect(repository.prepares + repository.submits + repository.abandons, 0);
      expect(import.canConfirm, isTrue);
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
        final live = ConnectorOpenApiImportController(
          ApiConnectorOpenApiImportRepository(_access(liveApi)),
          ImportFixtureStore(),
          now: () => importNow,
        );
        final safe = await ConnectorOpenApiImportPreparationIntent.prepare(
          connectorOwner,
          importDeclaration(),
        );
        (live.store as ImportFixtureStore).value = connectorFreeze({
          'schemaVersion': 'connector-openapi-import:1',
          'sequence': ConnectorOpenApiImportSequence(
            intent: safe,
            prepareDispatched: true,
          ).stored,
        });
        await live.initialize();
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(body: ConnectorOpenApiImportPanel(controller: live)),
          ),
        );
        await tester.pumpAndSettle();
        live.addListener(() => notifications++);
        await tester.scrollUntilVisible(
          find.text('Synthetic OpenAPI import'),
          150,
          scrollable: find.byType(Scrollable).first,
        );
        expect(find.text('Synthetic OpenAPI import'), findsOneWidget);
        liveApi.refusal = refusal;
        await live.recover();
        expect(live.sequence, isNull);
        expect(live.current, isFalse);
        expect(liveApi.tokens.every((token) => token.isCancelled), isTrue);
        await tester.pump();
        expect(notifications, greaterThan(1));
        expect(find.textContaining('Synthetic OpenAPI import'), findsNothing);
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
    late ApiConnectorOpenApiImportRepository repo;
    repo = ApiConnectorOpenApiImportRepository(
      _access(
        api,
        current: () {
          repo.close();
          return true;
        },
      ),
    );
    final intent = await ConnectorOpenApiImportPreparationIntent.prepare(
      connectorOwner,
      importDeclaration(),
    );
    await expectLater(repo.readPreparation(intent), throwsFormatException);
    expect(api.reads, 0);
    expect(repo.current, isFalse);
  });
  for (final auth in ['none', 'bearer_env', 'api_key_header_env']) {
    test(
      '$auth preparation uses the one-shot transient transport and latches 401',
      () async {
        final api = _Api()
          ..refusal = const ApiException('Refused', statusCode: 401);
        final repo = ApiConnectorOpenApiImportRepository(_access(api));
        final intent = await ConnectorOpenApiImportPreparationIntent.prepare(
          connectorOwner,
          importDeclaration(authType: auth),
        );
        await expectLater(
          repo.prepare(intent, importPayload(), () => true),
          throwsA(isA<ApiException>()),
        );
        expect(api.posts, 1);
        expect(api.timeout, const Duration(seconds: 55));
        expect(repo.current, isFalse);
        await expectLater(
          repo.prepare(intent, importPayload(), () => true),
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
              container.invalidate(connectorOpenApiImportControllerProvider);
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
      () => container.read(connectorOpenApiImportControllerProvider),
      returnsNormally,
    );
    expect(storageReads, 0);
  });

  testWidgets(
    'new OpenAPI form keeps safe defaults and creation requires its separate fresh confirmation',
    (tester) async {
      final repository = ImportFixtureRepository(),
          store = ImportFixtureStore();
      final c = ConnectorOpenApiImportController(
        repository,
        store,
        now: () => importNow,
      );
      await c.initialize();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
          ],
          child: MaterialApp(
            home: Scaffold(body: ConnectorOpenApiImportPanel(controller: c)),
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
      await tester.enterText(field('Connection name'), 'Local OpenAPI import');
      await show(field('Full specification URL'));
      await tester.enterText(field('Full specification URL'), importUrl);
      final endpoint = tester
          .widget<TextField>(field('Full specification URL'))
          .controller!;
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      final prepare = find.widgetWithText(
        FilledButton,
        'Prepare OpenAPI import',
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
      await show(find.text('Review and confirm import'));
      await Scrollable.ensureVisible(
        tester.element(find.text('Review and confirm import')),
        alignment: 0.5,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Review and confirm import').hitTestable());
      await tester.pumpAndSettle();
      expect(repository.preparationReads, 1);
      expect(repository.submits, 0);
      expect(
        find.text('Import this disabled OpenAPI connection?'),
        findsOneWidget,
      );
      await tester.tap(find.text('Confirm OpenAPI import').hitTestable());
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
    'URL, base and pasted text clear on hide and same-owner panel replacement',
    (tester) async {
      final c = ConnectorOpenApiImportController(
        ImportFixtureRepository(),
        ImportFixtureStore(),
        now: () => importNow,
      );
      await c.initialize();
      final visible = ValueNotifier(true);
      addTearDown(visible.dispose);
      final access = _access(_Api());
      Widget surface(ConnectorOpenApiImportController controller) =>
          ProviderScope(
            overrides: [
              nativeWorkspaceAccessProvider.overrideWithValue(access),
            ],
            child: MaterialApp(
              home: Scaffold(
                body: ValueListenableBuilder<bool>(
                  valueListenable: visible,
                  builder: (_, enabled, _) => TickerMode(
                    enabled: enabled,
                    child: ConnectorOpenApiImportPanel(controller: controller),
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
      await show(field('Full specification URL'));
      await tester.enterText(field('Full specification URL'), importUrl);
      final endpoint = tester
          .widget<TextField>(field('Full specification URL'))
          .controller!;
      await show(field('Optional API base URL'));
      await tester.enterText(
        field('Optional API base URL'),
        'https://example.test/api',
      );
      final base = tester
          .widget<TextField>(field('Optional API base URL'))
          .controller!;
      await tester.drag(find.byType(ListView).first, const Offset(0, 1200));
      await tester.pumpAndSettle();
      await show(find.text('Public specification URL'));
      await tester.tap(find.text('Public specification URL').hitTestable());
      await tester.pumpAndSettle();
      await tester.tap(find.text('Paste JSON or YAML').last);
      await tester.pumpAndSettle();
      await show(field('OpenAPI JSON or YAML'));
      await tester.enterText(field('OpenAPI JSON or YAML'), importText);
      final token = tester
          .widget<TextField>(field('OpenAPI JSON or YAML'))
          .controller!;
      endpoint.text = importUrl;
      base.text = 'https://example.test/api';
      visible.value = false;
      await tester.pump();
      expect(endpoint.text, isEmpty);
      expect(token.text, isEmpty);
      expect(base.text, isEmpty);
      visible.value = true;
      await tester.pumpAndSettle();
      endpoint.text = importUrl;
      token.text = importText;
      final next = ConnectorOpenApiImportController(
        ImportFixtureRepository(),
        ImportFixtureStore(),
        now: () => importNow,
      );
      await next.initialize();
      await tester.pumpWidget(surface(next));
      await tester.pumpAndSettle();
      expect(endpoint.text, isEmpty);
      expect(token.text, isEmpty);
      expect(base.text, isEmpty);
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
        final repo = ImportFixtureRepository(), store = ImportFixtureStore();
        final c = ConnectorOpenApiImportController(
          repo,
          store,
          now: () => importNow,
        );
        await c.initialize();
        await c.prepare(
          importDeclaration(),
          importPayload(),
          () => true,
          clearSecret: () {},
        );
        final visible = ValueNotifier(true),
            navigator = GlobalKey<NavigatorState>();
        addTearDown(visible.dispose);
        final container = ProviderContainer(
          overrides: [
            nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
            connectorOpenApiImportControllerProvider.overrideWith((ref) {
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
                home: const NativeConnectorOpenApiImportWorkspace(),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.text('Review and confirm import'),
          200,
          scrollable: find.byType(Scrollable).first,
        );
        await Scrollable.ensureVisible(
          tester.element(find.text('Review and confirm import')),
          alignment: 0.5,
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Review and confirm import').hitTestable());
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
        final confirm = find.widgetWithText(
          FilledButton,
          'Confirm OpenAPI import',
        );
        if (hide == 'none') {
          expect(confirm.hitTestable(), findsOneWidget);
          await tester.tap(confirm.hitTestable());
        } else {
          expect(c.summary, isNull);
          expect(find.text('GET /items'), findsNothing);
          expect(find.text('POST /items'), findsNothing);
          expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
          expect(
            find.textContaining('This review is no longer current.'),
            findsOneWidget,
          );
          await tester.tap(find.text('Cancel').hitTestable());
        }
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
