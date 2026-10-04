import 'dart:typed_data';

import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/features/companion/companion_controller.dart';
import 'package:asael/features/talk/talk.dart' hide Json;
import 'package:asael/features/today/today.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'features/companion/companion_fixtures.dart';

class _TodayRepository implements TodayRepository {
  @override
  Future<TodayItem> create({
    required String title,
    String kind = 'task',
    TodayPriority priority = TodayPriority.medium,
    DateTime? dueAt,
  }) async => throw UnimplementedError();

  @override
  Future<DailyBrief?> generateBrief({bool force = false}) async => null;

  @override
  Future<TodaySnapshot> load() async => throw UnimplementedError();

  @override
  Future<TodayItem> update(String id, Json changes) async =>
      throw UnimplementedError();
}

class _TalkRepository implements TalkRepository {
  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkRunInspection> inspectRun(String runId) async =>
      throw UnimplementedError();

  @override
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId) async =>
      throw UnimplementedError();

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

class _VoiceRecorder implements VoiceDraftRecorder {
  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {}

  @override
  Future<bool> hasPermission() async => true;

  @override
  Future<void> start(String outputPath) async {}

  @override
  Future<String?> stop() async => null;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<void> pumpPhone(
    WidgetTester tester,
    Widget child, {
    ThemeMode themeMode = ThemeMode.light,
  }) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        darkTheme: AppTheme.dark(),
        themeMode: themeMode,
        home: Material(child: child),
      ),
    );
    await tester.pump(const Duration(seconds: 1));
  }

  testWidgets('Today composes priorities, brief, and focus on a phone', (
    tester,
  ) async {
    final controller = TodayController(_TodayRepository())
      ..snapshot = TodaySnapshot(
        items: const [
          TodayItem(
            id: 'focus-1',
            title: 'Review launch evidence',
            kind: 'task',
            priority: TodayPriority.high,
            status: 'open',
          ),
        ],
        brief: DailyBrief(
          summary: 'Protect the launch window and close the evidence gap.',
          focus: const [
            (title: 'Verify Android build', reason: 'Keep release proof exact'),
          ],
          watchouts: const ['Notification receipt is still pending'],
          generatedAt: DateTime(2026, 9, 8),
        ),
        threads: const [(id: 'thread-1', title: 'Launch room')],
        projects: const [
          (id: 'project-1', title: 'Mobile launch', completed: 4, total: 6),
        ],
      );
    addTearDown(controller.dispose);

    await pumpPhone(tester, TodayView(controller: controller));

    expect(find.text('Today'), findsOneWidget);
    expect(find.text('Add focus').hitTestable(), findsOneWidget);
    expect(find.text('Refresh brief').hitTestable(), findsOneWidget);
    expect(find.text('1 open · 0 complete'), findsOneWidget);
    expect(find.text('Daily brief'), findsOneWidget);
    expect(find.text('Notification receipt is still pending'), findsOneWidget);
    final suggestions = find.text('Suggested focus');
    expect(suggestions.hitTestable(), findsOneWidget);
    await tester.tap(suggestions);
    await tester.pumpAndSettle();
    expect(find.text('Verify Android build'), findsOneWidget);
    await tester.drag(find.byType(CustomScrollView), const Offset(0, -400));
    await tester.pump();
    expect(find.text('Review launch evidence'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'Conversation keeps its composer visible and mode choices reachable on a phone',
    (tester) async {
      final controller = TalkController(_TalkRepository());
      final preferences = CompanionController(FakeCompanionRepository());
      addTearDown(controller.dispose);
      addTearDown(preferences.dispose);
      await preferences.refresh();
      await pumpPhone(
        tester,
        TalkView(
          controller: controller,
          companionController: preferences,
          voiceRecorder: _VoiceRecorder(),
        ),
        themeMode: ThemeMode.dark,
      );

      expect(find.text('Assistant'), findsOneWidget);
      expect(find.text('How can I help?'), findsOneWidget);
      final greeting = find.image(
        const AssetImage('assets/companion/atlas-greeting.png'),
      );
      expect(greeting, findsOneWidget);
      expect(tester.getSize(greeting).height, lessThanOrEqualTo(144));
      expect(find.byTooltip('Send message').hitTestable(), findsOneWidget);
      final options = find.byKey(const ValueKey('talk-composer-options'));
      expect(options.hitTestable(), findsOneWidget);
      expect(tester.getTopLeft(greeting).dy, greaterThanOrEqualTo(0));
      expect(
        tester.getBottomLeft(greeting).dy,
        lessThanOrEqualTo(tester.getTopLeft(options).dy),
      );
      await tester.tap(options);
      await tester.pumpAndSettle();
      expect(find.text('Use a team').hitTestable(), findsOneWidget);
      expect(find.text('Work alone').hitTestable(), findsOneWidget);
      expect(find.byTooltip('Send message').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
