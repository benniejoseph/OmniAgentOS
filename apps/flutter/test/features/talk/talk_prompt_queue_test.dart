import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'narrow Conversation exposes the queue and refresh reconciles the outbox',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      tester.view.physicalSize = const Size(900, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = _PromptQueueTalkRepository();
      final controller = TalkController(repository);
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        MaterialApp(
          theme: MacosAppTheme.light(),
          home: TalkView(
            controller: controller,
            voiceRecorder: _VoiceDraftRecorder(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(controller.artifacts, isEmpty);
      expect(find.byTooltip('Run artifacts'), findsNothing);
      expect(find.byTooltip('Prompt queue'), findsOneWidget);

      await tester.tap(find.byTooltip('Prompt queue'));
      await tester.pumpAndSettle();

      expect(find.text('Prompt queue'), findsOneWidget);
      expect(find.text('Queue is clear'), findsOneWidget);
      await tester.tap(find.byTooltip('Refresh synced queue'));
      await tester.pumpAndSettle();

      expect(repository.reconcileCalls, 1);
      expect(repository.listCalls, 0);
      expect(controller.promptQueue, hasLength(1));
      expect(find.text('Recovered offline prompt'), findsOneWidget);
      expect(tester.takeException(), isNull);
      debugDefaultTargetPlatformOverride = null;
    },
  );

  testWidgets('desktop Conversation keeps a single prompt queue rail action', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = TalkController(_PromptQueueTalkRepository());
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: TalkView(
          controller: controller,
          voiceRecorder: _VoiceDraftRecorder(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byTooltip('Prompt queue'), findsOneWidget);
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });
}

class _PromptQueueTalkRepository
    implements TalkRepository, TalkPromptQueueRepository {
  int listCalls = 0;
  int reconcileCalls = 0;

  static const reconciledPrompt = TalkQueuedPrompt(
    id: '00000000-0000-4000-8000-000000000001',
    clientCorrelationId: 'offline-prompt-1',
    input: 'Recovered offline prompt',
    mode: 'orchestrate',
    strategy: 'auto',
    executionTarget: TalkExecutionTarget.agent,
  );

  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkQueuedPrompt> createPromptQueueItem(
    TalkQueuedPrompt prompt,
  ) async => prompt;

  @override
  Future<void> deletePromptQueueItem(TalkQueuedPrompt prompt) async {}

  @override
  Stream<SseEvent> dispatchPromptQueueItem(
    TalkQueuedPrompt prompt, {
    required bool force,
  }) => const Stream.empty();

  @override
  Future<TalkRunInspection> inspectRun(String runId) async =>
      throw UnimplementedError();

  @override
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId) async =>
      throw UnimplementedError();

  @override
  Future<List<TalkQueuedPrompt>> listPromptQueue() async {
    listCalls += 1;
    return const [];
  }

  @override
  Future<List<TalkQueuedPrompt>> reconcilePromptQueue() async {
    reconcileCalls += 1;
    return const [reconciledPrompt];
  }

  @override
  Future<List<TalkQueuedPrompt>> reorderPromptQueue(
    List<TalkQueuedPrompt> prompts,
  ) async => prompts;

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
  Future<String> transcribeVoice(Uint8List bytes) async => 'Unused';

  @override
  Future<TalkQueuedPrompt> updatePromptQueueItem(
    TalkQueuedPrompt prompt, {
    String? input,
    String? state,
  }) async => prompt.copyWith(input: input, state: state);
}

class _VoiceDraftRecorder implements VoiceDraftRecorder {
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
