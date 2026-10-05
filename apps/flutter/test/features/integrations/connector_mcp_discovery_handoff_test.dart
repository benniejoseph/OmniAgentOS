import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_controller.dart';
import 'package:asael/features/integrations/connector_credential_rotation_controller.dart';
import 'package:asael/features/integrations/connector_credential_rotation_providers.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_controller.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_providers.dart';
import 'package:asael/features/integrations/connector_mcp_registration_controller.dart';
import 'package:asael/features/integrations/connector_mcp_registration_providers.dart';
import 'package:asael/features/integrations/connector_providers.dart';
import 'package:asael/features/integrations/connector_view.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_credential_rotation_fixtures.dart';
import 'connector_fixtures.dart';
import 'connector_mcp_discovery_fixtures.dart';
import 'connector_mcp_registration_fixtures.dart';

class _EmptyInventory extends ConnectorFixtureRepository {
  final targets = <({String kind, String id})>[];
  @override
  Future<ConnectorInventory> list() async =>
      const ConnectorInventory([], false);
  @override
  Future<ConnectorReview> review(String kind, String id) {
    targets.add((kind: kind, id: id));
    return super.review(kind, id);
  }
}

class _Api extends ApiClient {
  _Api()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));
  @override
  String get apiBaseUrl => connectorOwner.apiBaseUrl;
}

NativeWorkspaceAccess _access() => NativeWorkspaceAccess(
  _Api(),
  NativeRequestAuthority(
    tenantId: connectorOwner.tenantId,
    actorId: connectorOwner.actorId,
    canonicalUserId: connectorOwner.userId,
    role: connectorOwner.role,
    apiBaseUrl: connectorOwner.apiBaseUrl,
    isCurrent: () => true,
  ),
  false,
);

void main() {
  testWidgets(
    'empty inventory exposes a missing target journal and GET-only recovery returns the exact review',
    (tester) async {
      final store = DiscoveryFixtureStore();
      final first = ConnectorMcpDiscoveryController(
        DiscoveryFixtureRepository()..loseSubmit = true,
        store,
      );
      await first.initialize();
      await first.select('mcp:one');
      await first.act(first.reviewed!, () => true);
      expect(first.sequence!.dispatched, isTrue);
      first.dispose();
      final repository = DiscoveryFixtureRepository()..missingTarget = true;
      final discovery = ConnectorMcpDiscoveryController(repository, store);
      final inventory = _EmptyInventory();
      final controls = ConnectorController(inventory, ConnectorFixtureStore());
      await controls.initialize();
      final container = ProviderContainer(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(_access()),
          connectorControllerProvider.overrideWith((ref) => controls),
          connectorMcpDiscoveryControllerProvider.overrideWith(
            (ref) => discovery,
          ),
        ],
      );
      addTearDown(() {
        container.dispose();
        controls.dispose();
        discovery.dispose();
      });
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: NativeConnectorWorkspace()),
        ),
      );
      await tester.pumpAndSettle();
      final entry = find.text('MCP discovery recovery');
      await tester.scrollUntilVisible(
        entry,
        180,
        scrollable: find.byType(Scrollable).first,
      );
      await Scrollable.ensureVisible(tester.element(entry), alignment: 0.5);
      await tester.pumpAndSettle();
      await tester.tap(entry.hitTestable());
      await tester.pumpAndSettle();
      final missing = find.text(
        'This exact connection is unavailable. Its original attempt can still be recovered or explicitly closed.',
      );
      await tester.scrollUntilVisible(
        missing,
        180,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.pumpAndSettle();
      expect(missing, findsOneWidget);
      final recover = find.text('Check exact attempt');
      await Scrollable.ensureVisible(tester.element(recover), alignment: 0.5);
      await tester.pumpAndSettle();
      await tester.tap(recover.hitTestable());
      await tester.pumpAndSettle();
      expect(discovery.sequence!.terminal, isTrue);
      final review = find.text('Open exact connection review');
      await tester.scrollUntilVisible(
        review,
        180,
        scrollable: find.byType(Scrollable).last,
      );
      await Scrollable.ensureVisible(tester.element(review), alignment: 0.5);
      await tester.pumpAndSettle();
      await tester.tap(review.hitTestable());
      await tester.pumpAndSettle();
      expect(inventory.targets, [(kind: 'mcp', id: 'mcp:one')]);
      expect(controls.selectedId, 'mcp:one');
      expect(repository.reads, 1);
      expect(repository.submits + repository.closes, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final registration in [true, false]) {
    testWidgets(
      '${registration ? 'registration' : 'rotation'} receipt returns its exact MCP target outside inventory without another mutation',
      (tester) async {
        final registrationStore = RegistrationFixtureStore();
        final rotationStore = RotationFixtureStore();
        String target;
        if (registration) {
          final first = ConnectorMcpRegistrationController(
            RegistrationFixtureRepository(),
            registrationStore,
            now: () => registrationNow,
          );
          await first.initialize();
          await first.prepare(
            registrationDeclaration(),
            registrationEndpoint,
            registrationToken,
            () => true,
            clearSecret: () {},
          );
          await first.confirm(first.sequence!, () => true);
          target = first.sequence!.intent.id;
          expect(first.sequence!.terminal, isTrue);
          first.dispose();
        } else {
          final first = ConnectorCredentialRotationController(
            RotationFixtureRepository(),
            rotationStore,
            now: () => rotationNow,
          );
          await first.initialize();
          await first.select('mcp:one');
          await first.prepare(
            first.reviewed!,
            rotationToken,
            () => true,
            clearSecret: () {},
          );
          await first.confirm(first.reviewed!, () => true);
          target = first.sequence!.intent.id;
          expect(first.sequence!.terminal, isTrue);
          first.dispose();
        }
        final registrationRepository = RegistrationFixtureRepository();
        final rotationRepository = RotationFixtureRepository();
        final registering = ConnectorMcpRegistrationController(
          registrationRepository,
          registrationStore,
          now: () => registrationNow,
        );
        final rotating = ConnectorCredentialRotationController(
          rotationRepository,
          rotationStore,
          now: () => rotationNow,
        );
        final inventory = _EmptyInventory();
        final controls = ConnectorController(
          inventory,
          ConnectorFixtureStore(),
        );
        await controls.initialize();
        final container = ProviderContainer(
          overrides: [
            nativeWorkspaceAccessProvider.overrideWithValue(_access()),
            connectorControllerProvider.overrideWith((ref) => controls),
            connectorMcpRegistrationControllerProvider.overrideWith(
              (ref) => registering,
            ),
            connectorCredentialRotationControllerProvider.overrideWith(
              (ref) => rotating,
            ),
          ],
        );
        addTearDown(() {
          container.dispose();
          controls.dispose();
          registering.dispose();
          rotating.dispose();
        });
        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: const MaterialApp(home: NativeConnectorWorkspace()),
          ),
        );
        await tester.pumpAndSettle();
        final entry = find.text(
          registration
              ? 'MCP registration recovery'
              : 'Credential preparation recovery',
        );
        await tester.scrollUntilVisible(
          entry,
          180,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.pumpAndSettle();
        await tester.tap(entry.hitTestable());
        await tester.pumpAndSettle();
        final review = find.text('Open exact connection review');
        await tester.scrollUntilVisible(
          review,
          180,
          scrollable: find.byType(Scrollable).last,
        );
        await Scrollable.ensureVisible(tester.element(review), alignment: 0.5);
        await tester.pumpAndSettle();
        await tester.tap(review.hitTestable());
        await tester.pumpAndSettle();
        expect(inventory.targets, [(kind: 'mcp', id: target)]);
        expect(controls.selectedKind, 'mcp');
        expect(controls.selectedId, target);
        expect(
          registrationRepository.prepares +
              registrationRepository.submits +
              registrationRepository.abandons,
          0,
        );
        expect(
          rotationRepository.prepares +
              rotationRepository.submits +
              rotationRepository.abandons,
          0,
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
