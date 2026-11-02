import 'dart:async';

import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/native_visual_capture.dart';

void main() {
  setUpAll(loadNativeReviewFont);
  const advisory = TalkActivity(
    key: 'evidence:run',
    title: 'Evidence review needed',
    detail: 'A source needs review.',
    state: TalkActivityState.waiting,
  );

  for (final (status, title, state) in [
    ('completed', 'Response ready', TalkActivityState.succeeded),
    ('failed', 'Could not finish', TalkActivityState.failed),
    (
      'waiting_approval',
      'Waiting for your approval',
      TalkActivityState.waiting,
    ),
    ('waiting_clarification', 'Needs your input', TalkActivityState.waiting),
    ('canceled', 'Stopped', TalkActivityState.info),
  ]) {
    test(
      'the $status lifecycle takes precedence over a later source advisory',
      () {
        final summary = summarizeTalkWork(
          runStatus: status,
          sending: false,
          canceling: false,
          status: 'Working',
          activities: const [advisory],
        );
        expect(summary.title, title);
        expect(summary.state, state);
      },
    );
  }

  test('background work is not reported complete when the parent response finishes', () {
    const background = TalkActivity(
      key: 'delegated',
      title: 'Specialists are working',
      detail: '',
      state: TalkActivityState.active,
    );
    expect(
      summarizeTalkWork(
        runStatus: 'completed',
        sending: false,
        canceling: false,
        status: null,
        activities: const [background, advisory],
      ),
      same(background),
    );
  });

  test(
    'proposed specialist work and dry runs are not completed actions',
    () async {
      final repository = _ProgressRepository();
      final controller = TalkController(repository);
      addTearDown(controller.dispose);
      final sending = controller.send('Review the project');
      repository.events.add(
        const SseEvent(
          event: 'council_member',
          data: {
            'agentName': 'Scout',
            'agentId': 'scout',
            'status': 'completed',
            'lifecycleState': 'completed_proposed',
            'summary': 'Ready for review.',
          },
        ),
      );
      repository.events.add(
        const SseEvent(
          event: 'tool',
          data: {
            'toolId': 'local.macos.command.run',
            'toolName': 'Mac command',
            'status': 'dry_run',
            'summary': 'Preview only; no action ran.',
          },
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(
        controller.activities
            .firstWhere((item) => item.key.startsWith('agent:'))
            .state,
        TalkActivityState.waiting,
      );
      expect(
        controller.activities
            .firstWhere((item) => item.key.startsWith('tool:'))
            .state,
        TalkActivityState.info,
      );
      await repository.events.close();
      await sending;
    },
  );

  for (final (width, scale, dark) in [
    (360.0, 1.0, false),
    (840.0, 2.0, false),
    (1440.0, 1.0, true),
  ]) {
    testWidgets(
      'public notes remain readable and respect disclosure at $width / $scale',
      (tester) async {
        tester.view.physicalSize = Size(width, 940);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final repository = _ProgressRepository();
        final controller = TalkController(repository);
        addTearDown(controller.dispose);
        final theme = width == 1440 ? MacosAppTheme.dark() : AppTheme.light();
        const boundary = ValueKey('review-surface');
        await tester.pumpWidget(
          MaterialApp(
            theme: theme,
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(
                textScaler: TextScaler.linear(scale),
                disableAnimations: true,
              ),
              child: child!,
            ),
            home: RepaintBoundary(
              key: boundary,
              child: TalkView(
                controller: controller,
                voiceRecorder: _Recorder(),
              ),
            ),
          ),
        );
        final sending = controller.send(
          'Review this project and show the next useful step.',
        );
        repository.events.add(
          const SseEvent(
            event: 'status',
            data: {
              'label': 'Reading the project',
              'detail': 'Checking the README and nearby files.',
            },
          ),
        );
        repository.events.add(
          const SseEvent(
            event: 'memory',
            data: {'title': 'Context pack ready', 'count': 2},
          ),
        );
        repository.events.add(
          const SseEvent(
            event: 'model',
            data: {
              'provider': 'TEST_PRIVATE_MODEL',
              'reasoning': 'PRIVATE_REASONING',
            },
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Working notes'), findsOneWidget);
        expect(find.text('Context reviewed'), findsOneWidget);
        expect(find.textContaining('PRIVATE_'), findsNothing);
        expect(tester.takeException(), isNull);
        await captureNativeSurface(
          tester,
          boundary,
          'assistant-${width.toInt()}-${scale}x-${dark ? 'dark' : 'light'}',
        );
        final toggle = find.byKey(
          const ValueKey('assistant-working-notes-toggle'),
        );
        await tester.ensureVisible(toggle);
        await tester.tap(toggle);
        await tester.pumpAndSettle();
        expect(find.text('All activity and results'), findsNothing);
        repository.events.add(
          const SseEvent(
            event: 'status',
            data: {
              'label': 'Checking the result',
              'detail': 'Comparing the recorded changes.',
            },
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('All activity and results'), findsNothing);
        repository.events.add(
          const SseEvent(
            event: 'done',
            data: {'response': 'The project is ready for the next step.'},
          ),
        );
        await repository.events.close();
        await sending;
        await tester.pumpAndSettle();
        expect(find.text('Response ready'), findsOneWidget);
        expect(find.text('All activity and results'), findsNothing);
        await tester.ensureVisible(toggle);
        await tester.tap(toggle);
        await tester.pumpAndSettle();
        expect(find.text('All activity and results'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
      },
      variant: TargetPlatformVariant.only(
        width == 1440 ? TargetPlatform.macOS : TargetPlatform.android,
      ),
    );
  }
}

class _ProgressRepository extends Fake implements TalkRepository {
  final events = StreamController<SseEvent>();
  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    String? agentId,
    TalkCommandModelSelection? modelSelection,
  }) => events.stream;
}

class _Recorder extends Fake implements VoiceDraftRecorder {
  @override
  Future<void> cancel() async {}
  @override
  Future<void> dispose() async {}
}
