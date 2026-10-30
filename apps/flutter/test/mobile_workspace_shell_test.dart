import 'package:asael/app/navigation/app_destination.dart';
import 'package:asael/app/navigation/mobile_library_page.dart';
import 'package:asael/app/navigation/mobile_workspace_shell.dart';
import 'package:asael/app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('four phone places retain drafts and reach Capture and Listen', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final router = GoRouter(
      initialLocation: '/talk',
      routes: [
        StatefulShellRoute.indexedStack(
          builder: (context, state, shell) =>
              MobileWorkspaceShell(navigationShell: shell),
          branches: [
            for (final destination in appDestinations)
              StatefulShellBranch(
                routes: [
                  GoRoute(
                    path: destination.path,
                    builder: (context, state) => switch (destination.path) {
                      '/talk' => const Padding(
                        padding: EdgeInsets.all(20),
                        child: TextField(key: Key('assistant-draft')),
                      ),
                      '/library' => const MobileLibraryPage(),
                      '/capture' => Center(
                        child: Text(
                          state.uri.queryParameters['section'] == 'listen'
                              ? 'Listen workspace'
                              : 'Capture workspace',
                        ),
                      ),
                      _ => Center(child: Text('Body ${destination.label}')),
                    },
                  ),
                ],
              ),
          ],
        ),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [nativeWorkspaceAccessProvider.overrideWith((ref) => null)],
        child: MaterialApp.router(
          theme: AppTheme.light(),
          routerConfig: router,
        ),
      ),
    );
    await tester.pumpAndSettle();

    final dock = find.descendant(
      of: find.byWidgetPredicate(
        (widget) => widget is Scaffold && widget.bottomNavigationBar != null,
      ),
      matching: find.byType(Semantics),
    );
    for (final label in ['Today', 'Assistant', 'My work', 'Library']) {
      expect(find.text(label).hitTestable(), findsOneWidget);
    }
    expect(dock, findsWidgets);
    expect(find.text('Capture'), findsNothing);
    await tester.enterText(
      find.byKey(const Key('assistant-draft')),
      'Keep this',
    );
    for (final width in [720.0, 1000.0, 390.0]) {
      tester.view.physicalSize = Size(width, 844);
      await tester.pumpAndSettle();
      expect(find.text('Keep this'), findsOneWidget);
      expect(tester.takeException(), isNull);
    }
    final hiddenRail = tester.element(
      find.byType(NavigationRail, skipOffstage: false),
    );
    expect(TickerMode.valuesOf(hiddenRail).enabled, isFalse);
    for (var step = 0; step < 10; step++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      var focusedHiddenRail = false;
      FocusManager.instance.primaryFocus?.context?.visitAncestorElements((
        element,
      ) {
        if (element.widget is NavigationRail) focusedHiddenRail = true;
        return true;
      });
      expect(focusedHiddenRail, isFalse);
    }
    expect(find.text('Keep this'), findsOneWidget);
    await tester.tap(find.text('My work'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Assistant'));
    await tester.pumpAndSettle();
    expect(find.text('Keep this'), findsOneWidget);

    await tester.tap(find.text('Library'));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Needs you'), findsOneWidget);
    expect(find.text('Payments'), findsNothing);
    await tester.scrollUntilVisible(
      find.text('Capture'),
      220,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Capture'));
    await tester.pumpAndSettle();
    expect(find.text('Capture workspace'), findsOneWidget);
    router.pop();
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('Listen & conversations'),
      160,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Listen & conversations'));
    await tester.pumpAndSettle();
    expect(find.text('Listen workspace'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
