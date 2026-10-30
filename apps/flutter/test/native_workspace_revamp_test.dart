import 'dart:typed_data';

import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/app/theme/mobile_app_theme.dart';
import 'package:asael/features/knowledge/knowledge.dart' hide Json;
import 'package:asael/features/knowledge/knowledge_read_widgets.dart';
import 'package:asael/features/projects/project_workspaces.dart';
import 'package:asael/features/projects/projects.dart' hide Json;
import 'package:asael/features/talk/talk.dart' hide Json;
import 'package:asael/features/today/today.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'features/projects/projects_fixture.dart';
import 'support/native_visual_capture.dart';

class _TodayRepository extends Fake implements TodayRepository {}

class _TalkRepository extends Fake implements TalkRepository {
  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    String? agentId,
    TalkCommandModelSelection? modelSelection,
  }) => const Stream.empty();
  @override
  Future<String> transcribeVoice(Uint8List bytes) async => '';
}

class _Recorder extends Fake implements VoiceDraftRecorder {
  @override
  Future<void> dispose() async {}
  @override
  Future<void> cancel() async {}
}

class _KnowledgeRepository extends Fake implements KnowledgeRepository {
  int exactReads = 0;
  @override
  Future<MemoryRecord> getMemory(String id) async {
    exactReads++;
    return _memory(id, 'The brand uses thoughtful, practical explanations.');
  }
}

MemoryRecord _memory(String id, String content) => MemoryRecord.fromJson({
  'id': id,
  'title': 'Doreish AI brand voice',
  'content': content,
  'type': 'fact',
  'claimStatus': 'active',
  'evidenceRefs': <String>[],
});

const _captureKey = Key('native-workspace-capture');

void viewport(WidgetTester tester, Size size) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
}

Future<void> mount(
  WidgetTester tester,
  Widget child, {
  bool mac = false,
  bool dark = false,
  double textScale = 1,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: mac ? MacosAppTheme.light() : MobileAppTheme.light(),
      darkTheme: mac ? MacosAppTheme.dark() : MobileAppTheme.dark(),
      themeMode: dark ? ThemeMode.dark : ThemeMode.light,
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          disableAnimations: true,
          textScaler: TextScaler.linear(textScale),
        ),
        child: child!,
      ),
      home: RepaintBoundary(
        key: _captureKey,
        child: Material(child: child),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(loadNativeReviewFont);

  testWidgets('Today keeps its brief expanded as the workspace unfolds', (
    tester,
  ) async {
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = TodayController(_TodayRepository())
      ..snapshot = TodaySnapshot(
        items: const [
          TodayItem(
            id: 'task-1',
            title: 'Review the first fashion edit',
            kind: 'task',
            priority: TodayPriority.high,
            status: 'open',
          ),
          TodayItem(
            id: 'task-2',
            title: 'Prepare the AI weekly outline',
            kind: 'task',
            priority: TodayPriority.medium,
            status: 'open',
          ),
        ],
        brief: DailyBrief(
          summary: 'Two thoughtful pieces to move forward today.',
          focus: const [
            (
              title: 'Protect an hour for the first edit',
              reason: 'Keep the story focused',
            ),
          ],
          watchouts: const [],
          generatedAt: DateTime(2026, 10, 30),
        ),
        threads: const [(id: 'thread-1', title: 'AI weekly outline')],
        projects: const [
          (
            id: 'project-1',
            title: 'Aanya fashion stories',
            completed: 2,
            total: 5,
          ),
        ],
      );
    addTearDown(controller.dispose);
    viewport(tester, const Size(390, 844));
    await mount(tester, TodayView(controller: controller));
    await captureNativeSurface(tester, _captureKey, 'today-cover');
    await tester.tap(find.text('View your brief'));
    await tester.pumpAndSettle();
    expect(find.text('Protect an hour for the first edit'), findsOneWidget);
    for (final width in [720.0, 800.0, 900.0]) {
      viewport(tester, Size(width, 840));
      await tester.pumpAndSettle();
      expect(find.text('Protect an hour for the first edit'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await captureNativeSurface(
        tester,
        _captureKey,
        'today-width-${width.toInt()}',
      );
    }
    expect(
      find.text('Pick up where you left off').hitTestable(),
      findsOneWidget,
    );
    await captureNativeSurface(tester, _captureKey, 'today-unfolded');
    expect(tester.takeException(), isNull);
  }, variant: TargetPlatformVariant.only(TargetPlatform.android));

  testWidgets(
    'Long task summaries open complete text without completing the task',
    (tester) async {
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      viewport(tester, const Size(360, 800));
      final title = List.filled(
        25,
        'Review the current client evidence and document the next action.',
      ).join(' ');
      await mount(
        tester,
        Padding(
          padding: const EdgeInsets.all(24),
          child: TodayTaskTitle(title: title),
        ),
        textScale: 1.5,
      );
      await tester.tap(find.text('Read full task'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(SelectableText, title), findsOneWidget);
      expect(find.text('Done').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );

  testWidgets(
    'Work retains search and selected overview across fold sizes without writes',
    (tester) async {
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = WorkFixtureRepository();
      final projects = [
        fixtureProject(id: 'fashion', title: 'Aanya fashion stories'),
        fixtureProject(id: 'ai-weekly', title: 'Doreish AI weekly'),
      ];
      final controller = ProjectsController(repository)
        ..projects = projects
        ..loaded = true
        ..fresh = true;
      addTearDown(controller.dispose);
      Project? opened;
      viewport(tester, const Size(900, 840));
      await mount(
        tester,
        ProjectCollectionWorkspace(
          controller: controller,
          onOpen: (project) => opened = project,
        ),
      );
      await tester.enterText(
        find.byKey(const Key('mobile-project-search')),
        'Doreish',
      );
      await tester.pumpAndSettle();
      final listScroll = find.descendant(
        of: find.byKey(const PageStorageKey('mobile-project-list')),
        matching: find.byType(Scrollable),
      );
      final list = tester.state<ScrollableState>(listScroll);
      await tester.tap(find.byKey(const ValueKey('mobile-project-ai-weekly')));
      await tester.pumpAndSettle();
      final preview = find.byKey(
        const PageStorageKey('mobile-project-preview'),
      );
      expect(
        find.descendant(of: preview, matching: find.text('Doreish AI weekly')),
        findsOneWidget,
      );
      await captureNativeSurface(tester, _captureKey, 'work-unfolded');
      viewport(tester, const Size(360, 800));
      await tester.pumpAndSettle();
      expect(
        find
            .descendant(of: preview, matching: find.text('Doreish AI weekly'))
            .hitTestable(),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('mobile-project-preview-back')).hitTestable(),
        findsOneWidget,
      );
      expect(find.byKey(const Key('mobile-project-search')), findsNothing);
      await captureNativeSurface(tester, _captureKey, 'work-cover-detail');
      await tester.tap(find.byKey(const Key('mobile-project-preview-back')));
      await tester.pumpAndSettle();
      expect(tester.state<ScrollableState>(listScroll), same(list));
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('mobile-project-search')))
            .controller!
            .text,
        'Doreish',
      );
      expect(find.text('Aanya fashion stories'), findsNothing);
      await captureNativeSurface(tester, _captureKey, 'work-cover');
      viewport(tester, const Size(900, 840));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('mobile-project-search')))
            .controller!
            .text,
        'Doreish',
      );
      expect(
        find.descendant(of: preview, matching: find.text('Doreish AI weekly')),
        findsOneWidget,
      );
      await tester.tap(find.text('Open project'));
      expect(opened?.id, 'ai-weekly');
      expect(repository.writes, 0);
      expect(tester.takeException(), isNull);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );

  testWidgets(
    'System Back closes only the folded project preview before leaving Work',
    (tester) async {
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = WorkFixtureRepository();
      final controller = ProjectsController(repository)
        ..projects = [
          fixtureProject(id: 'fashion', title: 'Aanya fashion stories'),
          fixtureProject(id: 'ai-weekly', title: 'Doreish AI weekly'),
        ]
        ..loaded = true
        ..fresh = true;
      addTearDown(controller.dispose);
      viewport(tester, const Size(900, 840));
      await tester.pumpWidget(
        MaterialApp(
          theme: MobileAppTheme.light(),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => Navigator.of(context).push<void>(
                  MaterialPageRoute<void>(
                    builder: (_) => Material(
                      child: ProjectCollectionWorkspace(
                        controller: controller,
                        onOpen: (_) => fail('Full project route must not open'),
                      ),
                    ),
                  ),
                ),
                child: const Text('Open Work route'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open Work route'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('mobile-project-search')),
        'Doreish',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('mobile-project-ai-weekly')));
      await tester.pumpAndSettle();
      viewport(tester, const Size(360, 800));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('mobile-project-preview-back')).hitTestable(),
        findsOneWidget,
      );
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('mobile-project-preview-back')),
        findsNothing,
      );
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('mobile-project-search')))
            .controller!
            .text,
        'Doreish',
      );
      expect(find.text('Open Work route'), findsNothing);
      expect(repository.writes, 0);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.text('Open Work route'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );

  testWidgets(
    'Library folds the same exact inspector without refetching or losing selection',
    (tester) async {
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = _KnowledgeRepository();
      final controller =
          KnowledgeController(
              repository,
              canManage: false,
              mutationsAvailable: false,
            )
            ..state = KnowledgeState(
              memories: [
                _memory('brand-voice', 'Practical, thoughtful explanations.'),
              ],
              knowledge: const [],
              nodes: const [],
              edges: const [],
            );
      addTearDown(controller.dispose);
      viewport(tester, const Size(900, 840));
      await mount(tester, KnowledgeView(controller: controller));
      await tester.tap(find.text('Doreish AI brand voice'));
      await tester.pumpAndSettle();
      expect(repository.exactReads, 1);
      final inspector = tester.state(find.byType(KnowledgeMemoryInspector));
      await captureNativeSurface(tester, _captureKey, 'library-unfolded');
      viewport(tester, const Size(360, 800));
      await tester.pumpAndSettle();
      expect(
        tester.state(find.byType(KnowledgeMemoryInspector)),
        same(inspector),
      );
      expect(
        find.text('The brand uses thoughtful, practical explanations.'),
        findsOneWidget,
      );
      expect(repository.exactReads, 1);
      await captureNativeSurface(tester, _captureKey, 'library-cover');
      viewport(tester, const Size(900, 840));
      await tester.pumpAndSettle();
      expect(
        tester.state(find.byType(KnowledgeMemoryInspector)),
        same(inspector),
      );
      expect(repository.exactReads, 1);
      expect(tester.takeException(), isNull);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );

  testWidgets(
    'Assistant retains draft and reachable send through resize and large text',
    (tester) async {
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = TalkController(_TalkRepository());
      addTearDown(controller.dispose);
      viewport(tester, const Size(360, 800));
      final view = TalkView(controller: controller, voiceRecorder: _Recorder());
      await mount(tester, view);
      await captureNativeSurface(tester, _captureKey, 'assistant-cover');
      viewport(tester, const Size(900, 840));
      await tester.pumpAndSettle();
      await captureNativeSurface(tester, _captureKey, 'assistant-unfolded');
      viewport(tester, const Size(360, 800));
      await mount(tester, view, textScale: 1.5);
      final input = find.byType(EditableText).first;
      await tester.enterText(input, 'Help me plan the next video');
      await tester.pumpAndSettle();
      viewport(tester, const Size(900, 840));
      await tester.pumpAndSettle();
      expect(
        tester.widget<EditableText>(input).controller.text,
        'Help me plan the next video',
      );
      expect(find.byTooltip('Send message').hitTestable(), findsOneWidget);
      await captureNativeSurface(
        tester,
        _captureKey,
        'assistant-unfolded-large-text',
      );
      viewport(tester, const Size(360, 800));
      await tester.pumpAndSettle();
      expect(
        tester.widget<EditableText>(input).controller.text,
        'Help me plan the next video',
      );
      expect(find.byTooltip('Send message').hitTestable(), findsOneWidget);
      await captureNativeSurface(
        tester,
        _captureKey,
        'assistant-cover-large-text',
      );
      expect(tester.takeException(), isNull);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );

  testWidgets(
    'Mac Assistant has a readable composer and a single options row',
    (tester) async {
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = TalkController(_TalkRepository());
      addTearDown(controller.dispose);
      viewport(tester, const Size(1180, 820));
      await mount(
        tester,
        TalkView(controller: controller, voiceRecorder: _Recorder()),
        mac: true,
        dark: true,
      );
      final input = find.byType(EditableText).first;
      expect(tester.getSize(input).width, lessThanOrEqualTo(780));
      final options = find.byKey(const ValueKey('talk-composer-options'));
      expect(options.hitTestable(), findsOneWidget);
      expect(
        find.widgetWithText(FilterChip, 'Research').hitTestable(),
        findsOneWidget,
      );
      await captureNativeSurface(tester, _captureKey, 'assistant-mac-dark');
      await tester.tap(options);
      await tester.pumpAndSettle();
      expect(find.text('Use a team').hitTestable(), findsOneWidget);
      expect(find.byTooltip('Send message').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.tap(options);
      await tester.pumpAndSettle();
      viewport(tester, const Size(520, 700));
      await mount(
        tester,
        TalkView(controller: controller, voiceRecorder: _Recorder()),
        mac: true,
        dark: true,
        textScale: 2,
      );
      expect(find.byTooltip('Send message').hitTestable(), findsOneWidget);
      expect(
        find.byKey(const ValueKey('talk-composer-options')).hitTestable(),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );
}
