import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/meetings/macos_meetings_view.dart';
import 'package:asael/features/meetings/meetings.dart';
import 'package:asael/features/meetings/meetings_access.dart';
import 'package:asael/features/meetings/meetings_action_controller.dart';
import 'package:asael/features/meetings/meetings_action_widgets.dart';
import 'package:asael/features/meetings/meetings_draft_store.dart';
import 'package:asael/features/meetings/meetings_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_test_support.dart';

void main() {
  testWidgets(
    'protected recovery failure explains the hold and reload never sends the restored request',
    (tester) async {
      final repository = FakeMeetingsRepository(),
          store = _LostSaveAcknowledgementStore(),
          actions = MeetingActionController(repository, store, 'new');
      await actions.initialize();
      final exact = createSubmission();
      expect(await actions.submit(exact, refresh: () async => true), isFalse);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light(),
          home: Scaffold(
            body: SingleChildScrollView(
              child: MeetingActionFeedback(
                actions: actions,
                refresh: () async => true,
              ),
            ),
          ),
        ),
      );
      expect(find.textContaining('No server request was sent'), findsOneWidget);
      expect(find.text('Reload protected draft'), findsOneWidget);
      expect(find.text('Retry the exact saved request'), findsNothing);
      await tester.tap(find.text('Reload protected draft'));
      await tester.pumpAndSettle();
      expect(find.text('Exact unconfirmed request'), findsOneWidget);
      expect(find.text(exact.key), findsOneWidget);
      expect(find.text('Retry the exact saved request'), findsOneWidget);
      expect(repository.writes, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      actions.dispose();
    },
    variant: const TargetPlatformVariant({TargetPlatform.linux}),
  );
  testWidgets(
    'desktop agenda opens the selected exact record from a flat inspector',
    (tester) async {
      tester.view.physicalSize = const Size(1440, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = FakeMeetingsRepository();
      final agenda = MeetingsController(repository);
      Meeting? opened;
      await tester.pumpWidget(
        MaterialApp(
          theme: MacosAppTheme.light(),
          home: MacosMeetingsView(
            controller: agenda,
            onOpen: (meeting) => opened = meeting,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Meeting brief'), findsOneWidget);
      await tester.tap(find.byKey(const Key('macos-meeting-$meetingTestId')));
      await tester.pump();
      await tester.ensureVisible(find.byKey(const Key('macos-meeting-open')));
      await tester.tap(find.byKey(const Key('macos-meeting-open')));
      expect(opened?.id, meetingTestId);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      agenda.dispose();
    },
    variant: const TargetPlatformVariant({TargetPlatform.linux}),
  );
  testWidgets(
    'failed initial list never shows zero; stale list retains last-loaded coverage',
    (tester) async {
      final repository = FakeMeetingsRepository()
        ..listReader = () =>
            Future.error(const ApiException('Unavailable', statusCode: 503));
      final controller = MeetingsController(repository);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light(),
          home: MeetingsView(controller: controller, onOpen: (_) {}),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.textContaining('No meeting count has been confirmed'),
        findsOneWidget,
      );
      expect(find.textContaining('Loaded 0'), findsNothing);
      repository.listReader = null;
      await controller.refresh();
      await tester.pump();
      repository.listReader = () =>
          Future.error(const ApiException('Unavailable', statusCode: 503));
      await controller.refresh();
      await tester.pump();
      expect(find.textContaining('Last loaded 1'), findsOneWidget);
      expect(find.text('Launch review'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
    variant: const TargetPlatformVariant({TargetPlatform.linux}),
  );
  testWidgets(
    'phone at 200 percent retains evidence and hides private detail immediately on lock',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = FakeMeetingsRepository();
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: MeetingDetailView(id: meetingTestId, repository: repository),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Launch review'), findsOneWidget);
      expect(find.text('Participants & consent'), findsOneWidget);
      expect(tester.takeException(), isNull);
      repository.access.update(meetingOwner, available: false);
      await tester.pump();
      expect(find.text('Launch review'), findsNothing);
      expect(
        find.textContaining('Meeting access is unavailable'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
    variant: const TargetPlatformVariant({TargetPlatform.linux}),
  );
}

class _LostSaveAcknowledgementStore extends MemoryMeetingDraftStore {
  bool _fail = true;
  @override
  Future<void> write(
    MeetingsOwner owner,
    String route,
    Json payload, {
    required bool Function() isCurrent,
  }) async {
    await super.write(owner, route, payload, isCurrent: isCurrent);
    if (_fail) {
      _fail = false;
      throw StateError('The save acknowledgement was lost.');
    }
  }
}
