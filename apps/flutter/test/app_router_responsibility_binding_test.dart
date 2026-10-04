import 'package:asael/app/router/app_router.dart';
import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/responsibilities/responsibility_controller.dart';
import 'package:asael/features/responsibilities/responsibility_providers.dart';
import 'package:asael/features/responsibilities/responsibility_recovery_store.dart';
import 'package:asael/features/responsibilities/responsibility_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'features/responsibilities/responsibility_test_support.dart';

void main() {
  testWidgets('mounted Responsibility route replaces private owner state', (
    tester,
  ) async {
    final repository = TestResponsibilityRepository();
    final container = ProviderContainer(
      overrides: [
        responsibilityControllerProvider.overrideWith(
          (ref) => ResponsibilityController(
            repository,
            MemoryResponsibilityRecoveryStore(),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.light(),
          home: const ProviderBoundResponsibilityRoute(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final first = container.read(responsibilityControllerProvider);
    final purpose = find.byKey(const ValueKey('responsibility-field-purpose'));
    await tester.ensureVisible(purpose);
    await tester.enterText(purpose, 'Private draft from an earlier session');
    container.invalidate(responsibilityControllerProvider);
    await tester.pumpAndSettle();
    expect(
      container.read(responsibilityControllerProvider),
      isNot(same(first)),
    );
    expect(first.available, isFalse);
    expect(find.text('Private draft from an earlier session'), findsNothing);
    expect(repository.writes, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  }, variant: TargetPlatformVariant.only(TargetPlatform.android));

  testWidgets(
    'invalid Responsibility identity is rejected before a private provider read',
    (tester) async {
      final container = ProviderContainer(
        overrides: [
          responsibilityControllerProvider.overrideWith(
            (ref) => throw StateError(
              'Invalid identity must not access private state',
            ),
          ),
        ],
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: ProviderBoundResponsibilityRoute(
              focusId: 'responsibility%3Abad',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('This Responsibility link is invalid.'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'actual Responsibility deep link decodes once and New draft clears the route without effects',
    (tester) async {
      tester.view.physicalSize = const Size(1440, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = TestResponsibilityRepository();
      final route = '/responsibilities/${Uri.encodeComponent(testId)}';
      expect(isSafeInitialAppLocation(route), isTrue);
      final container = ProviderContainer(
        overrides: [
          sessionControllerProvider.overrideWith(_Sessions.new),
          appInitialLocationProvider.overrideWithValue(route),
          responsibilityControllerProvider.overrideWith(
            (ref) => ResponsibilityController(
              repository,
              MemoryResponsibilityRecoveryStore(),
            ),
          ),
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
      final controller = container.read(responsibilityControllerProvider);
      expect(
        tester
            .widget<ResponsibilityWorkspaceView>(
              find.byType(ResponsibilityWorkspaceView),
            )
            .focusId,
        testId,
      );
      expect(controller.selectedId, testId);
      expect(controller.record?.id, testId);
      await tester.tap(find.byKey(const Key('responsibility-new')));
      await tester.pumpAndSettle();
      expect(
        container
            .read(appRouterProvider)
            .routeInformationProvider
            .value
            .uri
            .toString(),
        '/responsibilities',
      );
      expect(controller.selectedId, isNull);
      expect(find.text('New Responsibility draft'), findsOneWidget);
      expect(repository.writes, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
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
    tenantId: 'tenant-a',
    actorId: 'owner@example.test',
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'owner@example.test',
    displayName: 'Owner',
    workspaceName: 'Synthetic',
    role: 'operator',
  );
}
