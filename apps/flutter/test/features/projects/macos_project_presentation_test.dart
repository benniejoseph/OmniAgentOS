import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/projects/project_workspaces.dart';
import 'package:asael/features/projects/projects.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/native_visual_capture.dart';
import 'projects_fixture.dart';

const _capture = Key('mac-project-capture');
const _longId = 'project:long-brief';
const _brandId = 'project:brand';
final _longBrief =
    '${List.filled(8, 'Prepare a coherent weekly creative plan across video, editorial and social. '
    'Review each draft against the brand brief, keep its source material, and '
    'record the next decision before publication.').join('\n\n')}\n\n'
    'Final acceptance: retain this complete explanation in the saved brief.';

class _Projects extends WorkFixtureRepository {
  int reads = 0;
  final values = <Project>[
    Project.fromJson({
      ...projectJson(id: _longId, title: 'Weekly creative plan'),
      'objective': _longBrief,
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
      'tasks': [
        {
          ...taskJson(parent: _longId),
          'title': 'Review the first editorial draft',
        },
        {...taskJson(id: 'task:done', parent: _longId, status: 'done')},
      ],
    }),
    Project.fromJson({
      ...projectJson(id: _brandId, title: 'Doreish AI'),
      'objective':
          'Create thoughtful, practical stories about AI and technology.',
      'tasks': <Json>[],
      'artifacts': <Json>[],
    }),
    for (var index = 0; index < 8; index++)
      Project.fromJson({
        ...projectJson(
          id: 'project:$index',
          title: 'Editorial series ${index + 1}',
        ),
        'objective': 'Develop the next episode and keep its supporting research together.',
        'tasks': <Json>[],
        'artifacts': <Json>[],
      }),
  ];

  @override
  Future<List<Project>> list() async {
    reads++;
    return values;
  }
}

Future<void> _mount(
  WidgetTester tester,
  ProjectsController controller, {
  bool dark = false,
  ValueChanged<Project>? onOpen,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1360, 900);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  await tester.pumpWidget(
    RepaintBoundary(
      key: _capture,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: dark ? MacosAppTheme.dark() : MacosAppTheme.light(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: ProjectCollectionWorkspace(
          desktop: true,
          controller: controller,
          onOpen: onOpen ?? (_) {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Finder _row(String id) => find.byKey(Key('macos-project-row-$id'));
Finder get _listScroll => find
    .descendant(
      of: find.byType(ListView).first,
      matching: find.byType(Scrollable),
    )
    .first;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(loadNativeReviewFont);

  for (final dark in [false, true]) {
    testWidgets(
      'actual Mac desktop ${dark ? 'dark' : 'light'} Work keeps long briefs readable and exact details discoverable',
      (tester) async {
        final repository = _Projects();
        final controller = ProjectsController(repository);
        final opened = <String>[];
        addTearDown(controller.dispose);
        await controller.refresh();
        await _mount(
          tester,
          controller,
          dark: dark,
          onOpen: (project) => opened.add(project.id),
        );

        // This is the desktop:true macOS branch, not the phone composition.
        expect(find.byKey(const Key('mobile-project-search')), findsNothing);
        expect(
          find.byKey(const ValueKey('macos-inspector-pane')),
          findsOneWidget,
        );
        expect(find.byKey(const Key('macos-projects-search')), findsOneWidget);
        expect(find.text('Project ID'), findsNothing);
        expect(find.text('Tenant ID'), findsNothing);
        expect(find.text('Owner actor ID'), findsNothing);
        expect(find.text(workStamp), findsNothing);
        expect(find.text('Updated today'), findsOneWidget);
        expect(tester.getSize(_row(_longId)).height, lessThan(190));
        final summary = tester.widget<Text>(
          find.byKey(const Key('macos-project-summary-$_longId')),
        );
        expect(summary.maxLines, 2);
        expect(summary.overflow, TextOverflow.ellipsis);
        final rowSemantics = tester.getSemantics(_row(_longId));
        expect(
          rowSemantics.label,
          contains('Weekly creative plan. Active. Not running.'),
        );
        expect(rowSemantics.label, contains('1 of 2 tasks complete'));
        expect(rowSemantics.label, isNot(contains(_longId)));
        expect(
          tester.widget<Semantics>(_row(_longId)).properties.selected,
          isTrue,
        );
        expect(
          tester.widget<Semantics>(_row(_longId)).properties.hint,
          'Show project overview',
        );
        expect(find.text('Read full brief'), findsOneWidget);
        expect(find.text('Details'), findsOneWidget);
        expect(
          tester.getTopLeft(find.text('Project overview')).dy,
          lessThan(120),
        );
        await captureNativeSurface(
          tester,
          _capture,
          'mac-projects-${dark ? 'dark' : 'light'}-1360',
        );

        await tester.tap(find.text('Read full brief'));
        await tester.pumpAndSettle();
        final complete = tester.widget<SelectableText>(
          find.byKey(const Key('macos-project-full-brief')),
        );
        expect(complete.data, _longBrief);
        expect(complete.maxLines, isNull);
        await tester.tap(find.text('Close'));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Details'));
        await tester.pumpAndSettle();
        expect(find.widgetWithText(SelectableText, _longId), findsOneWidget);
        expect(
          find.widgetWithText(SelectableText, 'tenant-one'),
          findsOneWidget,
        );
        expect(
          find.widgetWithText(SelectableText, 'actor-one'),
          findsOneWidget,
        );
        await tester.tap(find.text('Details'));
        await tester.pumpAndSettle();
        expect(find.text('Tenant ID'), findsNothing);

        await tester.tap(_row(_brandId));
        await tester.pumpAndSettle();
        expect(
          tester.widget<Semantics>(_row(_brandId)).properties.selected,
          isTrue,
        );
        expect(
          tester.widget<Semantics>(_row(_longId)).properties.selected,
          isFalse,
        );
        expect(
          find.byKey(const Key('macos-project-open-$_brandId')),
          findsOneWidget,
        );
        final scroll = tester.state<ScrollableState>(_listScroll).position;
        scroll.jumpTo(160);
        await tester.pumpAndSettle();

        // The Mac inspector becomes a scoped dialog; list position and exact
        // selection survive moving between a narrow and a wide window.
        tester.view.physicalSize = const Size(720, 900);
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(tester.state<ScrollableState>(_listScroll).position.pixels, 160);
        await tester.tap(find.byTooltip('Open inspector'));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('macos-project-open-$_brandId')),
          findsOneWidget,
        );
        await captureNativeSurface(
          tester,
          _capture,
          'mac-projects-${dark ? 'dark' : 'light'}-720-overview',
        );
        await tester.tap(find.byKey(const Key('macos-project-open-$_brandId')));
        expect(opened, [_brandId]);
        await tester.pumpAndSettle();
        expect(find.byType(Dialog), findsNothing);
        expect(tester.state<ScrollableState>(_listScroll).position.pixels, 160);
        tester.view.physicalSize = const Size(1360, 900);
        await tester.pumpAndSettle();
        expect(tester.state<ScrollableState>(_listScroll).position.pixels, 160);
        expect(
          find.byKey(const Key('macos-project-open-$_brandId')),
          findsOneWidget,
        );

        tester.state<ScrollableState>(_listScroll).position.jumpTo(0);
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const Key('macos-projects-search')),
          'Doreish',
        );
        await tester.pumpAndSettle();
        expect(_row(_brandId), findsOneWidget);
        expect(_row(_longId), findsNothing);
        expect(find.text('10 loaded projects · 1 match'), findsOneWidget);
        expect(repository.reads, 1);
        expect(repository.writes, 0);
        expect(tester.takeException(), isNull);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  }

  testWidgets(
    'Mac full project brief closes old content when the owner scope changes',
    (tester) async {
      final repository = _Projects();
      final scopedController = ProjectsController(repository);
      addTearDown(scopedController.dispose);
      await scopedController.refresh();
      await _mount(tester, scopedController);
      await tester.tap(find.text('Read full brief'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('macos-project-full-brief')), findsOneWidget);
      repository.access.update(
        tenant: 'tenant-two',
        actor: 'actor-two',
        nextRole: 'operator',
        available: true,
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('macos-project-full-brief')), findsNothing);
      expect(find.text('Work access changed'), findsOneWidget);
      expect(repository.writes, 0);
      expect(tester.takeException(), isNull);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  for (final replaceController in [false, true]) {
    testWidgets(
      'compact Mac overview revokes old details after ${replaceController ? 'controller replacement' : 'owner scope change'}',
      (tester) async {
        final repository = _Projects();
        final controller = ProjectsController(repository);
        addTearDown(controller.dispose);
        await controller.refresh();
        await _mount(tester, controller);
        tester.view.physicalSize = const Size(720, 900);
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Open inspector'));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('macos-project-open-$_longId')),
          findsOneWidget,
        );
        await tester.tap(find.text('Details'));
        await tester.pumpAndSettle();
        expect(
          find.widgetWithText(SelectableText, 'actor-one'),
          findsOneWidget,
        );

        if (replaceController) {
          final replacement = _Projects()
            ..values.clear()
            ..values.add(
              fixtureProject(id: 'project:new', title: 'New owner project'),
            );
          replacement.access.update(
            tenant: 'tenant-two',
            actor: 'actor-two',
            nextRole: 'operator',
            available: true,
          );
          final nextController = ProjectsController(replacement);
          addTearDown(nextController.dispose);
          await nextController.refresh();
          await _mount(tester, nextController);
          expect(find.byType(Dialog), findsNothing);
        } else {
          repository.access.update(
            tenant: 'tenant-two',
            actor: 'actor-two',
            nextRole: 'operator',
            available: true,
          );
          await tester.pumpAndSettle();
          expect(find.text('Work access changed'), findsOneWidget);
          // Returning to the former owner cannot revive this old snapshot.
          repository.access.update(
            tenant: 'tenant-one',
            actor: 'actor-one',
            nextRole: 'operator',
            available: true,
          );
          await controller.refresh();
          await tester.pumpAndSettle();
          expect(find.text('Work access changed'), findsOneWidget);
        }
        expect(find.widgetWithText(SelectableText, 'actor-one'), findsNothing);
        expect(
          find.byKey(const Key('macos-project-open-$_longId')),
          findsNothing,
        );
        expect(repository.writes, 0);
        expect(tester.takeException(), isNull);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  }
}
