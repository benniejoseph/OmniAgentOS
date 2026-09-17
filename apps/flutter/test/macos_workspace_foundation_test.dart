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

    final router = GoRouter(
      initialLocation: '/today',
      routes: [
        GoRoute(
          path: '/devices',
          builder: (_, _) => const Text('Devices body'),
        ),
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
      MaterialApp.router(theme: MacosAppTheme.light(), routerConfig: router),
    );
    await tester.pumpAndSettle();

    expect(find.text('Workspaces'), findsOneWidget);
    expect(find.text('Projects'), findsOneWidget);
    expect(find.text('Ask Asael or run a command'), findsOneWidget);
    expect(find.text('Body Today'), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);

    await tester.tap(find.text('Projects'));
    await tester.pumpAndSettle();
    expect(find.text('Body Projects'), findsOneWidget);
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });
}
