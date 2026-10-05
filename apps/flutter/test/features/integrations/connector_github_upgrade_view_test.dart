import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_controller.dart';
import 'package:asael/features/integrations/connector_github_upgrade_controller.dart';
import 'package:asael/features/integrations/connector_github_upgrade_providers.dart';
import 'package:asael/features/integrations/connector_providers.dart';
import 'package:asael/features/integrations/connector_view.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_fixtures.dart';
import 'connector_github_upgrade_fixtures.dart';

class _ConnectorInventory extends ConnectorFixtureRepository {
  _ConnectorInventory(this.endpoint);
  final String endpoint;

  @override
  Future<ConnectorInventory> list() async => ConnectorInventory([
    (await connectorReviewFixture(
      endpoint: endpoint,
      endpointRedacted: false,
    )).connector!,
  ], false);

  @override
  Future<ConnectorReview> review(String kind, String id) =>
      connectorReviewFixture(
        id: id,
        endpoint: endpoint,
        endpointRedacted: false,
      );
}

class _Api extends ApiClient {
  _Api({this.eligible = true, this.pinChanged = false})
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));
  final bool eligible, pinChanged;
  @override
  String get apiBaseUrl => connectorOwner.apiBaseUrl;

  @override
  Future<Map<String, dynamic>> getJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Map<String, dynamic>? query,
    CancelToken? cancelToken,
  }) async {
    if (path != NativePaths.connectorsNativeGithubUpgradesReview('mcp:one')) {
      throw StateError('Unexpected native proof request: $path');
    }
    return (await githubUpgradeReviewFixture(
      'mcp:one',
      eligible: eligible,
      pinChanged: pinChanged,
    )).raw;
  }
}

NativeWorkspaceAccess _access({
  bool eligible = true,
  bool pinChanged = false,
}) => NativeWorkspaceAccess(
  _Api(eligible: eligible, pinChanged: pinChanged),
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

Future<void> _showReview(WidgetTester tester) async {
  await tester.pumpAndSettle();
  final item = find.text('Reviewed tools');
  await tester.scrollUntilVisible(
    item,
    180,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.tap(item.hitTestable());
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'only a raw eligible official GitHub review exposes the upgrade',
    (tester) async {
      for (final (endpoint, eligible, pinChanged, expected) in [
        ('https://tools.example.test/mcp', true, false, false),
        ('https://api.githubcopilot.com/mcp', false, false, false),
        ('https://api.githubcopilot.com/mcp', true, true, false),
        ('https://api.githubcopilot.com/mcp', true, false, true),
      ]) {
        final controls = ConnectorController(
          _ConnectorInventory(endpoint),
          ConnectorFixtureStore(),
        );
        await controls.initialize();
        final container = ProviderContainer(
          overrides: [
            nativeWorkspaceAccessProvider.overrideWithValue(
              _access(eligible: eligible, pinChanged: pinChanged),
            ),
            connectorControllerProvider.overrideWith((ref) => controls),
          ],
        );
        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: const MaterialApp(home: NativeConnectorWorkspace()),
          ),
        );
        await _showReview(tester);
        final entry = find.text('Expand GitHub tools');
        if (expected) {
          await tester.scrollUntilVisible(
            entry,
            180,
            scrollable: find.byType(Scrollable).first,
          );
          expect(entry, findsOneWidget);
        } else {
          expect(entry, findsNothing);
        }
        await tester.pumpWidget(const SizedBox());
        container.dispose();
        controls.dispose();
      }
    },
  );

  testWidgets(
    'visible confirmation explains expansion before one-shot upgrade',
    (tester) async {
      final controls = ConnectorController(
        _ConnectorInventory('https://api.githubcopilot.com/mcp'),
        ConnectorFixtureStore(),
      );
      final repository = GithubUpgradeFixtureRepository();
      final upgrade = ConnectorGithubUpgradeController(
        repository,
        GithubUpgradeFixtureStore(),
      );
      await controls.initialize();
      final container = ProviderContainer(
        overrides: [
          nativeWorkspaceAccessProvider.overrideWithValue(_access()),
          connectorControllerProvider.overrideWith((ref) => controls),
          connectorGithubUpgradeControllerProvider.overrideWith(
            (ref) => upgrade,
          ),
        ],
      );
      addTearDown(() {
        container.dispose();
        controls.dispose();
        upgrade.dispose();
      });
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: NativeConnectorWorkspace()),
        ),
      );
      await _showReview(tester);
      final entry = find.text('Expand GitHub tools');
      await tester.scrollUntilVisible(
        entry,
        180,
        scrollable: find.byType(Scrollable).first,
      );
      await Scrollable.ensureVisible(tester.element(entry), alignment: 0.5);
      await tester.pumpAndSettle();
      await tester.tap(entry.hitTestable());
      await tester.pumpAndSettle();
      final prepare = find.text('Review GitHub upgrade');
      await tester.scrollUntilVisible(
        prepare,
        180,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.tap(prepare.hitTestable());
      await tester.pumpAndSettle();
      expect(repository.submits, 0);
      expect(find.textContaining('/mcp/x/all'), findsWidgets);
      expect(
        find.textContaining(
          'every discovered tool must be reviewed separately',
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('Confirm upgrade'));
      await tester.pumpAndSettle();
      expect(repository.submits, 1);
      expect(
        upgrade.sequence!.response!.result!['connectorStatus'],
        'disabled',
      );
      expect(find.textContaining('pending review'), findsWidgets);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
