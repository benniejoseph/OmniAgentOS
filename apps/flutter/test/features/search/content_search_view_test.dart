import 'dart:async';

import 'package:asael/app/navigation/adaptive_shell.dart';
import 'package:asael/app/navigation/app_destination.dart';
import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/search/content_search_contracts.dart';
import 'package:asael/features/search/content_search_controller.dart';
import 'package:asael/features/search/content_search_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import '../../native_workspace_fixture.dart';
import '../projects/projects_fixture.dart';
import 'search_test_support.dart';

void main() {
  testWidgets(
    'exact Work refusal clears prior detail and offers no automatic broader opening',
    (tester) async {
      final api = SearchTestApi();
      final project = projectJson(title: 'Previously readable Work');
      project['tenantId'] = 'tenant-test';
      project['tasks'] = [(taskJson()..['tenantId'] = 'tenant-test')];
      project['artifacts'] = <Object?>[];
      api.reader = (_) async => {'project': project};
      await tester.pumpWidget(
        nativeWorkspaceFixture(
          api: api,
          child: const MaterialApp(
            home: NativeSearchWorkPage(id: projectId, taskId: taskId),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Previously readable Work'), findsOneWidget);
      expect(find.text('Selected search result'), findsOneWidget);
      expect(find.text('Open project workspace'), findsOneWidget);
      api.reader = (_) async =>
          throw const ApiException('gone', statusCode: 404);
      await tester.tap(find.byTooltip('Refresh exact Work result'));
      await tester.pumpAndSettle();
      expect(find.text('Previously readable Work'), findsNothing);
      expect(find.text('Open project workspace'), findsNothing);
      expect(find.text('Retry exact Work read'), findsOneWidget);
      expect(api.paths, hasLength(2));
      expect(
        api.paths.every((path) => path.startsWith('/api/content-search/work/')),
        isTrue,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  for (final platform in [TargetPlatform.android, TargetPlatform.macOS]) {
    testWidgets(
      'deliberate native search and keyboard opening on ${platform.name}',
      (tester) async {
        tester.view.physicalSize = const Size(1100, 900);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final repo = SearchTestRepository();
        final c = ContentSearchController(repo);
        ContentSearchTarget? opened;
        await tester.pumpWidget(
          MaterialApp(
            theme: platform == TargetPlatform.macOS
                ? MacosAppTheme.light()
                : AppTheme.light(),
            home: Scaffold(
              body: ContentSearchView(
                controller: c,
                onOpen: (target) => opened = target,
              ),
            ),
          ),
        );
        await tester.enterText(
          find.byKey(const Key('content-search-query')),
          'topic',
        );
        expect(repo.requests, isEmpty);
        await tester.testTextInput.receiveAction(TextInputAction.search);
        await tester.pump();
        repo.requests.single.result.complete(searchResponse());
        await tester.pumpAndSettle();
        expect(find.text('Results for “topic”'), findsOneWidget);
        await tester.tap(find.text('Result one').first);
        expect(opened?.provider, ContentSearchProvider.conversations);
        expect(opened?.location, '/talk?thread=$searchThread');
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        expect(
          tester
              .widget<TextField>(find.byKey(const Key('content-search-query')))
              .controller!
              .text,
          isEmpty,
        );
        expect(c.groups, isEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        c.dispose();
      },
      variant: TargetPlatformVariant.only(platform),
    );
  }
  testWidgets(
    'hidden search cancels private reads and resumes with a fresh controller even without an intervening frame',
    (tester) async {
      final api = SearchTestApi();
      final held = Completer<SearchJson>();
      api.reader = (_) => held.future;
      late StateSetter visibility;
      var visible = true;
      await tester.pumpWidget(
        nativeWorkspaceFixture(
          api: api,
          child: MaterialApp(
            theme: AppTheme.light(),
            home: StatefulBuilder(
              builder: (context, setState) {
                visibility = setState;
                return Scaffold(
                  body: TickerMode(
                    enabled: visible,
                    child: const NativeContentSearchPage(),
                  ),
                );
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('content-search-query')),
        'private topic',
      );
      await tester.testTextInput.receiveAction(TextInputAction.search);
      await tester.pump();
      visibility(() => visible = false);
      await tester.pump();
      expect(api.tokens.single.isCancelled, isTrue);
      held.complete(searchResponseJson(query: 'private topic'));
      await tester.pump();
      visibility(() => visible = true);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('content-search-query')))
            .controller!
            .text,
        isEmpty,
      );
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('content-search-query')),
        'new topic',
      );
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('content-search-query')))
            .controller!
            .text,
        'new topic',
      );
      api.reader = (path) async =>
          searchResponseJson(query: Uri.parse(path).queryParameters['q']!);
      await tester.testTextInput.receiveAction(TextInputAction.search);
      await tester.pumpAndSettle();
      expect(find.text('Results for “new topic”'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  for (final platform in [TargetPlatform.android, TargetPlatform.macOS]) {
    testWidgets(
      'shell exposes content search and its keyboard shortcut on ${platform.name}',
      (tester) async {
        tester.view.physicalSize = platform == TargetPlatform.macOS
            ? const Size(1100, 800)
            : const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final router = GoRouter(
          initialLocation: '/today',
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
          ProviderScope(
            child: MaterialApp.router(
              theme: platform == TargetPlatform.macOS
                  ? MacosAppTheme.light()
                  : AppTheme.light(),
              routerConfig: router,
            ),
          ),
        );
        await tester.pumpAndSettle();
        if (platform == TargetPlatform.android) {
          await tester.tap(find.byTooltip('Search workspace content'));
          await tester.pumpAndSettle();
          expect(find.text('Body Search'), findsOneWidget);
          router.go('/today');
          await tester.pumpAndSettle();
        }
        final modifier = platform == TargetPlatform.macOS
            ? LogicalKeyboardKey.metaLeft
            : LogicalKeyboardKey.controlLeft;
        await tester.sendKeyDownEvent(modifier);
        await tester.sendKeyEvent(LogicalKeyboardKey.keyK);
        await tester.sendKeyUpEvent(modifier);
        await tester.pumpAndSettle();
        expect(find.text('Body Search'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
      },
      variant: TargetPlatformVariant.only(platform),
    );
  }
}
