import 'package:asael/app/navigation/adaptive_shell.dart';
import 'package:asael/app/navigation/app_destination.dart';
import 'package:asael/app/router/app_router.dart';
import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/core/platform/desktop_host_bridge.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/activity/activity.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/inbox/inbox.dart';
import 'package:asael/features/inbox/inbox_providers.dart';
import 'package:asael/features/results/results.dart';
import 'package:asael/features/results/results_providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

void main() {
  test(
    'primary metadata and native host retain all existing destinations',
    () async {
      final primary = destinationIndices(primary: true)
          .map((index) => appDestinations[index]);
      expect(primary.map((item) => item.label), [
        'Assistant',
        'Work',
        'Activity',
        'Memory',
        'Capabilities',
      ]);
      expect(appDestinations.map((item) => item.path).toSet(), {
        '/today',
        '/talk',
        '/capture',
        '/projects',
        '/activity',
        '/knowledge',
        '/agents',
        '/meetings',
        '/accounts',
        '/markets',
        '/automation',
        '/workflows',
        '/integrations',
        '/inbox',
        '/payments',
        '/results',
        '/quality',
        '/monitoring',
        '/security',
        '/settings',
      });
      expect(DesktopHostBridge.isWorkspaceRoute('/activity'), isTrue);
      expect(
        DesktopHostBridge.isWorkspaceRoute('https://outside.invalid/activity'),
        isFalse,
      );
      final opened = <String>[];
      final bridge = DesktopHostBridge(enabled: false)
        ..attachRouteOpener(opened.add);
      await bridge.handleNativeCall(
        const MethodCall('openRoute', {'route': '/activity'}),
      );
      expect(opened, ['/activity']);
    },
  );

  for (final width in [320.0, 390.0]) {
    testWidgets('five primary destinations and More fit $width at 200% text', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final router = GoRouter(
        initialLocation: '/activity',
        routes: [
          StatefulShellRoute.indexedStack(
            builder: (_, _, shell) => AdaptiveShell(navigationShell: shell),
            branches: [
              for (final destination in appDestinations)
                StatefulShellBranch(
                  routes: [
                    GoRoute(
                      path: destination.path,
                      builder: (_, _) =>
                          Center(child: Text('Body ${destination.label}')),
                    ),
                  ],
                ),
            ],
          ),
        ],
      );
      addTearDown(router.dispose);
      await tester.pumpWidget(
        MaterialApp.router(
          theme: AppTheme.light(),
          routerConfig: router,
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: const TextScaler.linear(2),
              disableAnimations: true,
            ),
            child: child!,
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final label in [
        'Assistant',
        'Work',
        'Activity',
        'Memory',
        'Capabilities',
        'More',
      ]) {
        final control = find.widgetWithText(TextButton, label);
        expect(control, findsOneWidget);
        expect(tester.getSize(control).height, greaterThanOrEqualTo(48));
        expect(tester.getSize(control).width, greaterThanOrEqualTo(48));
      }
      await tester.tap(find.widgetWithText(TextButton, 'More'));
      await tester.pumpAndSettle();
      final capture = find.descendant(
        of: find.byType(Drawer),
        matching: find.text('Capture'),
      );
      await tester.scrollUntilVisible(
        capture,
        200,
        scrollable: find.descendant(
          of: find.byType(Drawer),
          matching: find.byType(Scrollable),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(capture);
      await tester.pumpAndSettle();
      expect(find.text('Body Capture'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Activity'));
      await tester.pumpAndSettle();
      expect(find.text('Body Activity'), findsOneWidget);
      expect(tester.takeException(), isNull);
    }, variant: TargetPlatformVariant.only(TargetPlatform.android));
  }

  testWidgets(
    'actual native Results route decodes the exact run identity once',
    (tester) async {
      const id = 'run/with%2Fencoded:Ω';
      final repository = _ReadOnlyResults();
      final container = ProviderContainer(
        overrides: [
          sessionControllerProvider.overrideWith(_Sessions.new),
          appInitialLocationProvider.overrideWithValue(
            ActivityItem.runLocation(id),
          ),
          resultsRepositoryProvider.overrideWithValue(repository),
          reconnectCoordinatorProvider.overrideWithValue(
            ReconnectCoordinator(() async => const [], const Stream.empty()),
          ),
        ],
      );
      addTearDown(container.dispose);
      await container.read(sessionControllerProvider.future);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );
      await tester.pumpAndSettle();
      expect(repository.details, ['agent:$id']);
      expect(repository.mutations, isEmpty);
      expect(find.text('This linked result is unavailable.'), findsOneWidget);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );

  testWidgets(
    'actual native approval route selects only its exact kind and ID',
    (tester) async {
      const id = 'approval/with%2Fencoded:Ω';
      final repository = _ReadOnlyInbox(id);
      final container = ProviderContainer(
        overrides: [
          sessionControllerProvider.overrideWith(_Sessions.new),
          appInitialLocationProvider.overrideWithValue(
            '/inbox/approvals/${Uri.encodeComponent(id)}?kind=workflow',
          ),
          inboxRepositoryProvider.overrideWithValue(repository),
          reconnectCoordinatorProvider.overrideWithValue(
            ReconnectCoordinator(() async => const [], const Stream.empty()),
          ),
        ],
      );
      addTearDown(container.dispose);
      await container.read(sessionControllerProvider.future);
      tester.view.physicalSize = const Size(900, 1400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );
      await tester.pumpAndSettle();
      final view = tester.widget<InboxView>(find.byType(InboxView));
      expect(view.focusApprovalId, id);
      expect(view.focusApprovalKind, 'workflow');
      final focused = tester
          .widgetList<ApprovalCard>(find.byType(ApprovalCard))
          .where((card) => card.focused)
          .toList();
      expect(focused, hasLength(1));
      expect(focused.single.item.kind, 'workflow');
      expect(focused.single.item.id, id);
      expect(repository.mutations, isEmpty);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );
}

class _RouterHarness extends ConsumerWidget {
  const _RouterHarness();
  @override
  Widget build(BuildContext context, WidgetRef ref) => MaterialApp.router(
    theme: AppTheme.light(),
    routerConfig: ref.watch(appRouterProvider),
  );
}

class _Sessions extends SessionController {
  @override
  Future<AppSession?> build() async => const AppSession(
    tenantId: 'tenant-synthetic',
    actorId: 'actor-synthetic',
    userId: 'user-synthetic',
    email: 'synthetic@example.test',
    displayName: 'Synthetic',
    workspaceName: 'Synthetic',
  );
}

class _ReadOnlyResults implements ResultsRepository {
  final details = <String>[];
  final mutations = <String>[];
  @override
  Future<ResultsSnapshot> list() async =>
      const ResultsSnapshot(items: [], evaluations: [], sourceErrors: []);
  @override
  Future<ResultItem?> detail(String key) async {
    details.add(key);
    return null;
  }

  @override
  Future<void> cancel(String runId) async {
    mutations.add(runId);
    throw StateError('No effects allowed');
  }
}

class _ReadOnlyInbox implements InboxRepository {
  _ReadOnlyInbox(this.id);
  final String id;
  final mutations = <String>[];
  @override
  Future<ApprovalQueue> loadApprovals() async => ApprovalQueue(
    items: [
      for (final kind in ['tool', 'workflow'])
        ApprovalItem(
          id: id,
          kind: kind,
          title: 'Exact $kind proposal',
          status: 'waiting_approval',
          riskLevel: 1,
          input: const {},
        ),
    ],
    tools: 1,
    workflows: 1,
    sloPolicies: 0,
  );
  @override
  Future<NotificationCenter> loadNotifications() async => NotificationCenter(
    notifications: const [],
    unreadCount: 0,
    quietHoursActive: false,
    generatedAt: DateTime.utc(2026, 10, 3),
  );
  @override
  Future<NotificationDispositionHistory> loadNotificationDispositions() async =>
      const NotificationDispositionHistory(
        version: 'notification-disposition-projection:1',
        items: [],
      );
  @override
  Future<void> decide(
    ApprovalItem item, {
    required bool approve,
    String? reason,
    bool breakGlass = false,
    String? ticket,
  }) async {
    mutations.add('decide');
    throw StateError('No effects allowed');
  }

  @override
  Future<void> readAllNotifications() async {
    mutations.add('readAll');
    throw StateError('No effects allowed');
  }

  @override
  Future<void> updateNotification(
    PersonalNotification notification,
    NotificationAction action, {
    int? snoozeMinutes,
  }) async {
    mutations.add('notification');
    throw StateError('No effects allowed');
  }
}
