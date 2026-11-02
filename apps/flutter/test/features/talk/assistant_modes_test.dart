import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/talk/assistant_modes.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final mode in ['chat', 'cowork', 'coding', 'research', 'execute', 'learn']) {
    test(
      'restores $mode and the owned project from conversation history',
      () async {
        final controller = TalkController(_HistoryRepository(mode));
        addTearDown(controller.dispose);
        final thread = TalkThreadSummary.fromJson({
          'id': '11111111-1111-4111-8111-111111111111',
          'title': 'Project conversation',
          'mode': mode,
          'projectId': 'project-example',
        });
        expect(await controller.openThread(thread.id), isTrue);
        final resumedMode = mode == 'learn' ? 'chat' : mode;
        expect(controller.assistantMode, resumedMode);
        expect(controller.selectedThread?.projectId, 'project-example');
        expect(controller.voiceConversationContext, containsPair('mode', resumedMode));
        expect(
          controller.voiceConversationContext,
          containsPair('projectId', 'project-example'),
        );
        expect(controller.voiceConversationContext['contextScope'], 'project');
        controller.newConversation();
        expect(controller.assistantMode, 'cowork');
        expect(controller.selectedThread, isNull);
        expect(controller.voiceConversationContext['mode'], 'cowork');
        expect(controller.voiceConversationContext['contextScope'], 'session');
        expect(
          controller.voiceConversationContext.containsKey('projectId'),
          isFalse,
        );
      },
    );
  }

  for (final width in [360.0, 840.0, 1440.0]) {
    for (final textScale in [1.0, 1.6]) {
      testWidgets(
        'switches modes and preserves the draft at $width with text scale $textScale',
        (tester) async {
          tester.view.physicalSize = Size(width, 900);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final controller = TalkController(_Repository());
          addTearDown(controller.dispose);
          await tester.pumpWidget(
            MaterialApp(
              theme: width == 1440 ? MacosAppTheme.light() : AppTheme.light(),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context).copyWith(
                  disableAnimations: true,
                  textScaler: TextScaler.linear(textScale),
                ),
                child: child!,
              ),
              home: TalkView(
                controller: controller,
                voiceRecorder: _Recorder(),
              ),
            ),
          );
          await tester.pumpAndSettle();
          final composer = find.descendant(
            of: find.byType(TalkCommandComposer),
            matching: find.byType(EditableText),
          );
          await tester.enterText(
            composer,
            'Keep this draft while I choose how to work',
          );
          for (final mode in AssistantMode.values) {
            await tester.tap(
              find.descendant(
                of: find.byType(AssistantModePicker),
                matching: find.text(mode.label),
              ),
            );
            await tester.pumpAndSettle();
            expect(controller.assistantMode, mode.name);
            expect(
              tester.widget<EditableText>(composer).controller.text,
              'Keep this draft while I choose how to work',
            );
            expect(tester.takeException(), isNull);
          }
          expect(find.text('Files & changes'), findsOneWidget);
          expect(controller.threadId, isNull);
          expect(controller.messages, isEmpty);
          await tester.pumpWidget(const SizedBox.shrink());
        },
        variant: TargetPlatformVariant.only(
          width == 1440 ? TargetPlatform.macOS : TargetPlatform.android,
        ),
      );
    }
  }
}

class _Repository extends Fake implements TalkRepository {}

class _HistoryRepository extends _Repository implements TalkHistoryRepository {
  _HistoryRepository(this.mode);
  final String mode;
  @override
  Future<TalkThreadDetail> getThread(String id) async => TalkThreadDetail(
    thread: TalkThreadSummary.fromJson({
      'id': id,
      'title': 'Project conversation',
      'mode': mode,
      'projectId': 'project-example',
    }),
    turns: const [],
  );
  @override
  Future<List<TalkThreadMemorySummary>> listThreadMemories(
    String id, {
    int limit = 24,
  }) async => [];
}

class _Recorder extends Fake implements VoiceDraftRecorder {
  @override
  Future<void> cancel() async {}
  @override
  Future<void> dispose() async {}
}
