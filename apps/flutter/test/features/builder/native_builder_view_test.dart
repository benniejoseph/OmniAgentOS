import 'package:asael/features/builder/builder_contracts.dart';
import 'package:asael/features/builder/builder_controller.dart';
import 'package:asael/features/builder/builder_widgets.dart';
import 'package:asael/features/builder/native_builder_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'builder_test_support.dart';

void main() {
  late TestBuilderRepository repository;
  late BuilderController controller;
  setUp(() {
    repository = TestBuilderRepository();
    controller = BuilderController(
      repository,
      TestRecoveryStore(),
      builderProject,
      now: () => DateTime.utc(2026, 10, 4, 10, 30),
    );
  });
  tearDown(() {
    controller.dispose();
    repository.access.dispose();
  });
  Future<void> show(
    WidgetTester tester, {
    double width = 320,
    double scale = 2,
    bool active = true,
    bool desktop = false,
    NativeBuilderExternalOpener? opener,
    String? artifact,
  }) async {
    tester.view.resetPhysicalSize();
    tester.view.physicalSize = Size(width, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: NativeBuilderWorkspace(
          controller: controller,
          active: active,
          desktop: desktop,
          exactArtifactId: artifact,
          externalOpener: opener,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> close(WidgetTester tester) async =>
      tester.pumpWidget(const SizedBox.shrink());
  Finder scrollable() => find.byType(Scrollable).first;

  testWidgets(
    '320px at 200 percent text retains full identity and reachable controls without overflow',
    (tester) async {
      await show(tester, artifact: 'artifact:full/private/identity');
      expect(find.text(builderProject), findsOneWidget);
      expect(find.text('artifact:full/private/identity'), findsOneWidget);
      expect(
        find.textContaining(
          'Artifact content is not independently verified here.',
        ),
        findsOneWidget,
      );
      await tester.scrollUntilVisible(
        find.text('Open exact preview'),
        300,
        scrollable: scrollable(),
      );
      expect(
        tester
            .widget<BuilderActionButton>(
              find.widgetWithText(BuilderActionButton, 'Open exact preview'),
            )
            .action,
        isNull,
      );
      expect(tester.takeException(), isNull);
      await tester.scrollUntilVisible(
        find.text('Verification record'),
        300,
        scrollable: scrollable(),
      );
      expect(find.text(buildId('session')), findsOneWidget);
      expect(repository.submissions, isEmpty);
      await close(tester);
    },
  );
  testWidgets(
    'inactive retained Build subtree does not read, poll or open preview',
    (tester) async {
      final opener = _Opener();
      await show(tester, active: false, opener: opener);
      expect(repository.reads, 0);
      expect(opener.urls, isEmpty);
      expect(find.text('Work / Build'), findsNothing);
      await close(tester);
    },
  );
  testWidgets(
    'preview opens only after an explicit action with the exact current safe URL',
    (tester) async {
      final opener = _Opener();
      await show(tester, width: 1200, scale: 1, desktop: true, opener: opener);
      expect(opener.urls, isEmpty);
      await tester.ensureVisible(find.text('Open exact preview'));
      await tester.tap(find.text('Open exact preview'));
      await tester.pumpAndSettle();
      expect(
        opener.urls.single,
        Uri.parse('https://sandbox.example.test/?token=do-not-persist'),
      );
      expect(opener.probes.single(), isTrue);
      repository.access.update(null, available: false);
      await tester.pump();
      expect(opener.probes.single(), isFalse);
      expect(find.text(builderProject), findsNothing);
      await close(tester);
    },
  );
  testWidgets(
    'same-owner session loading hides source and restores the retained dirty draft',
    (tester) async {
      await show(tester, width: 800, scale: 1);
      controller.choose(nextCanvas: 'code');
      controller.editDraft('confidential local draft');
      await tester.pumpAndSettle();
      repository.access.update(null, available: false);
      await tester.pump();
      expect(find.text('confidential local draft'), findsNothing);
      expect(find.textContaining('Build is unavailable'), findsOneWidget);
      repository.access.update(testBuilderOwner(), available: true);
      await tester.pumpAndSettle();
      expect(controller.draft, 'confidential local draft');
      expect(
        find.widgetWithText(TextField, 'confidential local draft'),
        findsOneWidget,
      );
      await close(tester);
    },
  );
  testWidgets(
    'desktop keyboard save uses the immutable file SHA and waits for a receipt',
    (tester) async {
      await show(tester, width: 1200, scale: 1, desktop: true);
      controller.choose(nextCanvas: 'code');
      await tester.pumpAndSettle();
      final editor = find.byWidgetPredicate(
        (widget) =>
            widget is TextField &&
            widget.decoration?.labelText == 'Source code',
      );
      await tester.ensureVisible(editor);
      await tester.enterText(editor, 'keyboard source edit');
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyS);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pumpAndSettle();
      expect(repository.submissions.single['action'], 'file.update');
      expect(repository.submissions.single['expectedSha256'], sha());
      expect(repository.submissions.single['content'], 'keyboard source edit');
      expect(controller.outcome!.state, BuilderOutcomeState.accepted);
      expect(tester.takeException(), isNull);
      await close(tester);
    },
  );
  testWidgets(
    'receipt expansion and scroll position use independent exact scope storage',
    (tester) async {
      await show(tester, width: 1200, scale: 1, desktop: true);
      controller.choose(nextCanvas: 'code');
      await tester.pumpAndSettle();
      final scrollKey = builderStorageKey(controller, 'scroll');
      final scrollContext = tester.element(find.byKey(scrollKey));
      final bucket = PageStorage.of(scrollContext);
      // ExpansionTile must not read this double when a new receipt appears.
      bucket.writeState(scrollContext, 240.0);
      controller.editDraft('source with an accepted receipt');
      await controller.saveFile();
      await tester.pumpAndSettle();
      final outcomeIdentity = 'outcome:${controller.outcome!.key}';
      final tileKey = builderStorageKey(controller, outcomeIdentity);
      expect(find.byKey(tileKey), findsOneWidget);
      expect(tester.takeException(), isNull);
      final tileContext = tester.element(find.byKey(tileKey));
      bucket.writeState(tileContext, true);
      expect(bucket.readState(tileContext), isTrue);
      expect(bucket.readState(scrollContext), isA<double>());
      final keys = tester
          .widgetList<ExpansionTile>(find.byType(ExpansionTile))
          .map((tile) => tile.key)
          .toList();
      expect(keys.every((key) => key is PageStorageKey), isTrue);
      expect(keys.toSet(), hasLength(keys.length));
      expect(keys, isNot(contains(scrollKey)));
      final originalOwnerKey = tileKey;
      repository.access.update(
        testBuilderOwner(user: builderOtherUser),
        available: true,
      );
      expect(
        builderStorageKey(controller, outcomeIdentity),
        isNot(originalOwnerKey),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await close(tester);
    },
  );
  testWidgets(
    'uncertain action retains full targets and has no immediate retry button',
    (tester) async {
      await controller.initialize();
      repository.mutation = (_, _) => Future.error(StateError('Lost response'));
      await controller.command('build');
      // Do not let the automatic initial read claim a user inspected the result.
      controller.setActive(false);
      await show(tester, active: false);
      controller.setActive(true);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: BuilderOutcomePanel(controller: controller)),
        ),
      );
      await tester.pump();
      expect(
        find.text('Action outcome uncertain · command.run'),
        findsOneWidget,
      );
      expect(
        find.textContaining('No action will be retried automatically.'),
        findsOneWidget,
      );
      expect(
        tester
            .widget<BuilderActionButton>(find.byType(BuilderActionButton))
            .action,
        isNull,
      );
      expect(repository.submissions, hasLength(1));
      await close(tester);
    },
  );
}

class _Opener implements NativeBuilderExternalOpener {
  final List<Uri> urls = [];
  final List<bool Function()> probes = [];
  @override
  Future<bool> open(Uri uri, {required bool Function() isCurrent}) async {
    urls.add(uri);
    probes.add(isCurrent);
    return isCurrent();
  }
}
