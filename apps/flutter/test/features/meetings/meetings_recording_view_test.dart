import 'package:asael/features/meetings/meetings.dart';
import 'package:asael/features/meetings/meetings_recording_controller.dart';
import 'package:asael/features/meetings/meetings_recording_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_recording_fixtures.dart';
import 'meetings_test_support.dart';

void main() {
  testWidgets(
    'phone recording review and receipt stay reachable at 200% with one protected POST',
    (tester) async {
      final old = WidgetController.hitTestWarningShouldBeFatal;
      WidgetController.hitTestWarningShouldBeFatal = true;
      addTearDown(() => WidgetController.hitTestWarningShouldBeFatal = old);
      tester.view.physicalSize = const Size(320, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = RecordingRepository(),
          store = RecordingStore(),
          controller = MeetingRecordingController(repository, store);
      addTearDown(controller.dispose);
      repository.onProcess = (sent) async {
        final journal = await store.read(
          meetingOwner,
          MeetingRecordingController.route,
        );
        expect(journal!['pendingDispatched'], isTrue);
        expect(journal['pending']['requestSha256'], sent.requestSha256);
        return recordingResultFixture(sent, phase: 'reconciliation_required');
      };
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: Scaffold(
            body: SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: MeetingRecordingPanel(
                controller: controller,
                meeting: Meeting.fromJson(meetingJson(source: true)),
                isCurrent: () => true,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> reach(Finder target) async {
        expect(target, findsOneWidget);
        await tester.ensureVisible(target);
        await tester.pumpAndSettle();
        expect(target.hitTestable(), findsOneWidget);
      }

      final open = find.widgetWithText(
        OutlinedButton,
        'Review recording processing',
      );
      await reach(open);
      await tester.tap(open);
      await tester.pumpAndSettle();
      final languages = find.widgetWithText(TextField, 'Language codes');
      await reach(languages);
      expect((tester.widget<TextField>(languages)).controller!.text, 'en');
      final review = find.widgetWithText(
        FilledButton,
        'Review processing choices',
      );
      await reach(review);
      await tester.tap(review);
      await tester.pumpAndSettle();
      expect(repository.posts, 0);
      final retention = find.text('Retention: keep original audio.');
      await reach(retention);
      final confirm = find.widgetWithText(
        FilledButton,
        'Process reviewed recording',
      );
      await reach(confirm);
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(repository.posts, 1);
      expect(controller.pending, isNull);
      await reach(find.text('Recording processing accepted'));
      await reach(find.text('Structured media output is saved.'));
      await reach(find.text('Private Knowledge indexing: Unconfirmed'));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
