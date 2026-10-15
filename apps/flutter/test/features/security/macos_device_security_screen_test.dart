import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/features/push/mobile_push.dart';
import 'package:asael/features/security/device_security.dart';
import 'package:asael/features/security/device_security_providers.dart';
import 'package:asael/features/security/device_security_screen.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import '../../native_workspace_fixture.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('macOS shows a selectable installation ledger and inspector', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    tester.view.physicalSize = const Size(1280, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final repository = _DeviceRepository();
    final controller = DeviceSecurityController(
      repository: repository,
      readBiometricEnabled: () async => true,
      readBiometricAvailable: () async => true,
      changeBiometricEnabled: (_) async {},
    );
    await controller.refresh();

    await tester.pumpWidget(
      nativeWorkspaceFixture(
        child: ProviderScope(
          overrides: [
            deviceSecurityControllerProvider.overrideWith((ref) => controller),
            mobilePushCoordinatorProvider.overrideWith((ref) => null),
          ],
          child: MaterialApp(
            theme: MacosAppTheme.light(),
            home: const DeviceSecurityScreen(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Devices & Security'), findsOneWidget);
    expect(find.text('Signed-in installations'), findsOneWidget);
    expect(find.byIcon(Icons.laptop_mac_rounded), findsWidgets);
    expect(find.text('This Mac'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('macos-device-old-mac')));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('macos-device-inspector-old-mac')),
      findsOneWidget,
    );
    expect(find.text('Revoke session'), findsOneWidget);
    await tester.tap(find.text('Revoke session'));
    await tester.pumpAndSettle();

    expect(find.text('Revoke Studio Mac?'), findsOneWidget);
    expect(find.text('Cancel'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(repository.changeCount, 0);
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('non-macOS keeps the existing device presentation', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    final controller = DeviceSecurityController(
      repository: _DeviceRepository(),
      readBiometricEnabled: () async => false,
      readBiometricAvailable: () async => false,
      changeBiometricEnabled: (_) async {},
    );
    await controller.refresh();

    await tester.pumpWidget(
      nativeWorkspaceFixture(
        child: ProviderScope(
          overrides: [
            deviceSecurityControllerProvider.overrideWith((ref) => controller),
            mobilePushCoordinatorProvider.overrideWith((ref) => null),
          ],
          child: const MaterialApp(home: DeviceSecurityScreen()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Devices & app lock'), findsOneWidget);
    expect(find.text('Back to workspace'), findsNothing);
    expect(find.text('Protection on this Mac'), findsNothing);
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets(
    'Mac devices returns through the router and preserves the workspace',
    (tester) async {
      final router = await _pumpDeviceNavigation(tester);
      await tester.enterText(find.byType(TextField), 'Keep this unsent draft');
      await tester.tap(find.text('Open devices'));
      await tester.pumpAndSettle();

      final devicesContext = tester.element(find.byType(DeviceSecurityScreen));
      expect(Navigator.of(devicesContext).canPop(), isFalse);
      expect(GoRouter.of(devicesContext).canPop(), isTrue);
      expect(find.bySemanticsLabel('Back to workspace'), findsOneWidget);

      await tester.tap(find.text('Back to workspace'));
      await tester.pumpAndSettle();

      expect(
        router.routeInformationProvider.value.uri.toString(),
        '/talk?thread=return-thread',
      );
      expect(find.text('Assistant workspace'), findsOneWidget);
      expect(find.text('Keep this unsent draft'), findsOneWidget);
      expect(find.byType(DeviceSecurityScreen), findsNothing);
      expect(tester.takeException(), isNull);
      debugDefaultTargetPlatformOverride = null;
    },
  );

  testWidgets('Mac devices opened directly returns to Today without a pop', (
    tester,
  ) async {
    final router = await _pumpDeviceNavigation(
      tester,
      initialLocation: '/devices',
    );
    expect(router.canPop(), isFalse);
    expect(find.bySemanticsLabel('Back to workspace'), findsOneWidget);

    await tester.tap(find.text('Back to workspace'));
    await tester.pumpAndSettle();

    expect(router.routeInformationProvider.value.uri.path, '/today');
    expect(find.text('Today workspace'), findsOneWidget);
    expect(find.byType(DeviceSecurityScreen), findsNothing);
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });
}

Future<GoRouter> _pumpDeviceNavigation(
  WidgetTester tester, {
  String initialLocation = '/talk?thread=return-thread',
}) async {
  debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
  addTearDown(() => debugDefaultTargetPlatformOverride = null);
  tester.view.physicalSize = const Size(1024, 700);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final controller = DeviceSecurityController(
    repository: _DeviceRepository(),
    readBiometricEnabled: () async => false,
    readBiometricAvailable: () async => false,
    changeBiometricEnabled: (_) async {},
  );
  await controller.refresh();
  final router = GoRouter(
    initialLocation: initialLocation,
    routes: [
      GoRoute(
        path: '/talk',
        builder: (context, _) => Scaffold(
          body: Column(
            children: [
              const Text('Assistant workspace'),
              const TextField(),
              TextButton(
                onPressed: () => context.push('/devices'),
                child: const Text('Open devices'),
              ),
            ],
          ),
        ),
      ),
      GoRoute(
        path: '/today',
        builder: (_, _) => const Scaffold(body: Text('Today workspace')),
      ),
      GoRoute(
        path: '/devices',
        builder: (_, _) => NativePrivateWorkspace(
          ownNavigator: true,
          builder: (_) => const DeviceSecurityScreen(),
        ),
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    nativeWorkspaceFixture(
      child: ProviderScope(
        overrides: [
          deviceSecurityControllerProvider.overrideWith((ref) => controller),
          mobilePushCoordinatorProvider.overrideWith((ref) => null),
        ],
        child: MaterialApp.router(
          theme: MacosAppTheme.light(),
          routerConfig: router,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return router;
}

class _DeviceRepository implements DeviceSecurityRepository {
  int changeCount = 0;

  @override
  Future<List<MobileDeviceSession>> loadDevices() async => [
    MobileDeviceSession(
      id: 'current-mac',
      current: true,
      state: 'active',
      name: 'Bennie’s MacBook Pro',
      platform: 'macos',
      appVersion: '2.0.0',
      buildNumber: 42,
      createdAt: DateTime.utc(2026, 9, 1),
      lastSeenAt: DateTime.utc(2026, 9, 17, 8, 30),
    ),
    MobileDeviceSession(
      id: 'old-mac',
      current: false,
      state: 'active',
      name: 'Studio Mac',
      platform: 'macos',
      appVersion: '1.8.0',
      buildNumber: 31,
      createdAt: DateTime.utc(2026, 7, 12),
      lastSeenAt: DateTime.utc(2026, 9, 12, 12),
    ),
  ];

  @override
  Future<MobileDeviceSession> changeDevice(
    String id,
    DeviceLifecycleAction action,
  ) async {
    changeCount += 1;
    throw UnimplementedError();
  }
}
