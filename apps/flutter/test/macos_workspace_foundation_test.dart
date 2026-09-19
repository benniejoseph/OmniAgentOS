import 'package:asael/app/macos/macos_page_scaffold.dart';
import 'package:asael/app/navigation/adaptive_shell.dart';
import 'package:asael/app/navigation/app_destination.dart';
import 'package:asael/app/platform/macos_presentation.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('macOS presentation stays isolated from web and other platforms', () {
    expect(
      usesMacosPresentation(isWeb: false, platform: TargetPlatform.macOS),
      isTrue,
    );
    expect(
      usesMacosPresentation(isWeb: true, platform: TargetPlatform.macOS),
      isFalse,
    );
    expect(
      usesMacosPresentation(isWeb: false, platform: TargetPlatform.android),
      isFalse,
    );
  });

  testWidgets('Mac page frame keeps actions, body, and inspector visible', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1380, 860);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: MacosPageScaffold(
          title: 'Evidence',
          description: 'Review verified work and its sources.',
          icon: Icons.fact_check_outlined,
          primaryAction: FilledButton(
            onPressed: () {},
            child: const Text('Create report'),
          ),
          body: const Center(child: Text('Evidence ledger')),
          inspector: const Center(child: Text('Source inspector')),
        ),
      ),
    );

    expect(find.text('Evidence'), findsOneWidget);
    expect(find.text('Review verified work and its sources.'), findsOneWidget);
    expect(find.text('Create report'), findsOneWidget);
    expect(find.text('Evidence ledger'), findsOneWidget);
    expect(find.text('Source inspector'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Mac shell keeps labelled navigation at minimum main width', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    tester.view.physicalSize = const Size(1024, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final router = _workspaceRouter();
    addTearDown(router.dispose);

    await tester.pumpWidget(
      MaterialApp.router(theme: MacosAppTheme.light(), routerConfig: router),
    );
    await tester.pumpAndSettle();

    expect(find.text('Workspaces'), findsOneWidget);
    expect(find.text('Projects'), findsOneWidget);
    expect(find.text('Automation Studio'), findsOneWidget);
    expect(find.text('Automations'), findsNothing);
    expect(find.text('Connections'), findsNothing);
    expect(find.text('Capabilities'), findsNothing);
    expect(find.text('Ask Asael or run a command'), findsOneWidget);
    expect(find.text('Body Today'), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
    _expectDestinationSemantics(
      tester,
      path: '/today',
      label: 'Today',
      hint: 'Open workspace with ⌘1',
      selected: true,
    );

    await tester.tap(find.text('Projects'));
    await tester.pumpAndSettle();
    expect(find.text('Body Projects'), findsOneWidget);
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('collapsed Mac navigation keeps explicit destination semantics', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    tester.view.physicalSize = const Size(900, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final router = _workspaceRouter();
    addTearDown(router.dispose);

    await tester.pumpWidget(
      MaterialApp.router(theme: MacosAppTheme.light(), routerConfig: router),
    );
    await tester.pumpAndSettle();

    final projectsTile = find.byKey(
      const ValueKey('macos-destination-/projects'),
    );
    expect(find.text('Workspaces'), findsNothing);
    _expectDestinationSemantics(
      tester,
      path: '/today',
      label: 'Today',
      hint: 'Open workspace with ⌘1',
      selected: true,
    );
    _expectDestinationSemantics(
      tester,
      path: '/projects',
      label: 'Projects',
      hint: 'Open workspace with ⌘4',
      selected: false,
    );

    await tester.tap(projectsTile);
    await tester.pumpAndSettle();
    expect(find.text('Body Projects'), findsOneWidget);
    _expectDestinationSemantics(
      tester,
      path: '/projects',
      label: 'Projects',
      hint: 'Open workspace with ⌘4',
      selected: true,
    );
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });
}

GoRouter _workspaceRouter() => GoRouter(
  initialLocation: '/today',
  routes: [
    GoRoute(path: '/devices', builder: (_, _) => const Text('Devices body')),
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

void _expectDestinationSemantics(
  WidgetTester tester, {
  required String path,
  required String label,
  required String hint,
  required bool selected,
}) {
  final finder = find.byKey(ValueKey('macos-destination-$path'));
  expect(finder, findsOneWidget);
  final properties = tester.widget<Semantics>(finder).properties;
  expect(properties.button, isTrue);
  expect(properties.selected, selected);
  expect(properties.label, label);
  expect(properties.hint, hint);
  expect(properties.onTap, isNotNull);
}
