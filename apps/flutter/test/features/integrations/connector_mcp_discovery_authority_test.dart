import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/agents/specialist_api_client.dart';
import 'package:asael/features/agents/specialist_recovery_store.dart';
import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_contracts.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_controller.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_providers.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_repository.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_view.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_fixtures.dart';
import 'connector_mcp_discovery_fixtures.dart';

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
  Duration? timeout;
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
    return (await connectorReviewFixture()).raw;
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
    throw refusal ?? StateError('Synthetic response lost');
  }
}

void main() {
  test('successful access probe that disposes repository cannot dispatch or revive it', () async {
    final api = _Api();
    late ApiConnectorMcpDiscoveryRepository repository;
    repository = ApiConnectorMcpDiscoveryRepository(
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
    expect(repository.current, isFalse);
  });

  test(
    'provider construction invalidated inside access probe never reads storage',
    () {
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
                container.invalidate(connectorMcpDiscoveryControllerProvider);
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
        () => container.read(connectorMcpDiscoveryControllerProvider),
        returnsNormally,
      );
      expect(storageReads, 0);
    },
  );

  test('discovery uses the bounded one-shot transport and a refused authority permanently closes it', () async {
    final api = _Api()
      ..refusal = const ApiException('Refused', statusCode: 401);
    final repository = ApiConnectorMcpDiscoveryRepository(_access(api));
    final intent = await ConnectorMcpDiscoveryIntent.prepare(
      connectorOwner,
      await connectorReviewFixture(),
    );
    await expectLater(
      repository.submit(intent, () => true),
      throwsA(isA<ApiException>()),
    );
    expect(api.posts, 1);
    expect(api.timeout, const Duration(seconds: 55));
    expect(repository.current, isFalse);
    await expectLater(
      repository.submit(intent, () => true),
      throwsFormatException,
    );
    expect(api.posts, 1);
  });

  for (final refusal in [
    const ApiException('Refused', statusCode: 401),
    const ApiException('Refused', statusCode: 403),
    const NativeAuthorityVerificationException(),
  ]) {
    testWidgets(
      'authority refusal clears private review and pending state with an actual repaint: $refusal',
      (tester) async {
        final api = _Api();
        final c = ConnectorMcpDiscoveryController(
          ApiConnectorMcpDiscoveryRepository(_access(api)),
          DiscoveryFixtureStore(),
        );
        await c.initialize();
        await c.select('mcp:one');
        await c.act(c.reviewed!, () => true);
        await c.refresh();
        expect(c.sequence, isNotNull);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(body: ConnectorMcpDiscoveryPanel(controller: c)),
          ),
        );
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.text('Reviewed tools'),
          180,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pumpAndSettle();
        expect(find.text('Reviewed tools'), findsOneWidget);
        var notifications = 0;
        c.addListener(() => notifications++);
        api.refusal = refusal;
        await c.refresh();
        await tester.pumpAndSettle();
        expect(notifications, greaterThanOrEqualTo(2));
        expect(c.current, isFalse);
        expect(c.reviewed, isNull);
        expect(c.sequence, isNull);
        expect(find.text('Reviewed tools'), findsNothing);
        expect(
          find.text('Return to the unlocked workspace to review discovery.'),
          findsOneWidget,
        );
        expect(api.tokens.every((token) => token.isCancelled), isTrue);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        c.dispose();
      },
    );
  }

  for (final outer in [true, false]) {
    testWidgets(
      '${outer ? 'outer route' : 'TickerMode'} loss clears an open private confirmation and consumes its epoch',
      (tester) async {
        final repository = DiscoveryFixtureRepository();
        final controller = ConnectorMcpDiscoveryController(
          repository,
          DiscoveryFixtureStore(),
        );
        await controller.initialize();
        await controller.select('mcp:one');
        final visible = ValueNotifier(true);
        addTearDown(visible.dispose);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: ValueListenableBuilder<bool>(
                valueListenable: visible,
                builder: (_, enabled, _) => TickerMode(
                  enabled: outer || enabled,
                  child: ConnectorMcpDiscoveryPanel(
                    controller: controller,
                    routeCurrent: !outer || enabled,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final button = find.text('Review discovery attempt');
        await tester.scrollUntilVisible(
          button,
          180,
          scrollable: find.byType(Scrollable).first,
        );
        await Scrollable.ensureVisible(tester.element(button), alignment: 0.5);
        await tester.pumpAndSettle();
        await tester.tap(button.hitTestable());
        await tester.pumpAndSettle();
        expect(find.text('Confirm discovery'), findsOneWidget);
        visible.value = false;
        await tester.pumpAndSettle();
        expect(find.text('Reviewed tools'), findsNothing);
        expect(controller.reviewed, isNull);
        expect(
          tester
              .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Confirm discovery'),
              )
              .onPressed,
          isNull,
        );
        visible.value = true;
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Confirm discovery'),
              )
              .onPressed,
          isNull,
        );
        expect(repository.submits, 0);
        expect(controller.sequence, isNull);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      },
    );
  }

  testWidgets(
    'visible discovery confirmation performs one fresh exact review and one submission',
    (tester) async {
      final repository = DiscoveryFixtureRepository();
      final controller = ConnectorMcpDiscoveryController(
        repository,
        DiscoveryFixtureStore(),
      );
      await controller.initialize();
      await controller.select('mcp:one');
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ConnectorMcpDiscoveryPanel(controller: controller),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final tool = find.text('Read a selected item');
      await tester.scrollUntilVisible(
        tool,
        180,
        scrollable: find.byType(Scrollable).first,
      );
      await Scrollable.ensureVisible(tester.element(tool), alignment: 0.5);
      await tester.pumpAndSettle();
      await tester.tap(tool.hitTestable());
      await tester.pumpAndSettle();
      expect(find.textContaining('"inputSchema"'), findsOneWidget);
      final review = find.text('Review discovery attempt');
      await tester.scrollUntilVisible(
        review,
        180,
        scrollable: find.byType(Scrollable).first,
      );
      await Scrollable.ensureVisible(tester.element(review), alignment: 0.5);
      await tester.pumpAndSettle();
      await tester.tap(review.hitTestable());
      await tester.pumpAndSettle();
      expect(repository.submits, 0);
      final confirm = find.widgetWithText(FilledButton, 'Confirm discovery');
      expect(tester.widget<FilledButton>(confirm).onPressed, isNotNull);
      await tester.tap(confirm.hitTestable());
      await tester.pumpAndSettle();
      expect(repository.reviews, 2);
      expect(repository.submits, 1);
      expect(repository.closes, 0);
      expect(controller.sequence!.terminal, isTrue);
      expect(controller.reviewed, isNull);
      expect(controller.storageUnconfirmed, isFalse);
      expect(find.text('Discovery completed'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );

  testWidgets(
    'same-owner provider replacement consumes the old review and its late response',
    (tester) async {
      final oldRepository = DiscoveryFixtureRepository();
      final old = ConnectorMcpDiscoveryController(
        oldRepository,
        DiscoveryFixtureStore(),
      );
      await old.initialize();
      await old.select('mcp:one');
      final next = ConnectorMcpDiscoveryController(
        DiscoveryFixtureRepository(),
        DiscoveryFixtureStore(),
      );
      await next.initialize();
      var active = old;
      final container = ProviderContainer(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(_access(_Api())),
          connectorMcpDiscoveryControllerProvider.overrideWith((ref) {
            final captured = active;
            ref.onDispose(captured.dispose);
            return captured;
          }),
        ],
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: NativeConnectorMcpDiscoveryWorkspace(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final original = find.text('Reviewed tools');
      await tester.scrollUntilVisible(
        original,
        180,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.pumpAndSettle();
      expect(original, findsOneWidget);
      oldRepository.reviewGate = Completer<ConnectorReview>();
      final pending = old.refresh();
      active = next;
      container.invalidate(connectorMcpDiscoveryControllerProvider);
      await tester.pumpAndSettle();
      oldRepository.reviewGate!.complete(await connectorReviewFixture());
      await pending;
      await tester.pumpAndSettle();
      expect(old.current, isFalse);
      expect(old.reviewed, isNull);
      expect(next.reviewed, isNull);
      expect(find.text('Reviewed tools'), findsNothing);
      expect(oldRepository.submits, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
