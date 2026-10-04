import 'dart:async';

import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/features/meetings/meetings.dart';
import 'package:asael/features/meetings/meetings_action_controller.dart';
import 'package:asael/features/meetings/meetings_action_widgets.dart';
import 'package:asael/features/meetings/meetings_draft_store.dart';
import 'package:asael/features/meetings/meetings_project_selector.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_test_support.dart';

Future<List<MeetingProjectChoice>> _projects(CancelToken _) async => const [
  MeetingProjectChoice('project:review', 'Release review project'),
];

Future<void> _mount(
  WidgetTester tester,
  MeetingActionController actions, {
  Meeting? base,
  MeetingProjectLoader loader = _projects,
  double scale = 1,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      child: MaterialApp(
        theme: AppTheme.light(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: Scaffold(
          body: Builder(
            builder: (context) => FilledButton(
              onPressed: () => unawaited(
                showDialog<void>(
                  context: context,
                  builder: (_) => Dialog(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 720),
                      child: MeetingEditor(
                        actions: actions,
                        workspaceId: 'workspace:native',
                        base: base,
                        stillCurrent: () => actions.available,
                        refresh: () async => true,
                        projectLoader: loader,
                      ),
                    ),
                  ),
                ),
              ),
              child: const Text('Open editor'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open editor'));
  await tester.pumpAndSettle();
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Future<void> _enter(WidgetTester tester, Finder finder, String value) async {
  await tester.ensureVisible(finder);
  await tester.enterText(finder, value);
  await tester.pump();
}

void main() {
  testWidgets(
    'phone at 200 percent submits reviewed participant consent and a selected project through the existing controller',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = FakeMeetingsRepository()
        ..writer = createMeetingReceipt;
      final actions = MeetingActionController(
        repository,
        MemoryMeetingDraftStore(),
        'new',
      );
      await actions.initialize();
      await _mount(tester, actions, scale: 2);
      await _enter(
        tester,
        find.widgetWithText(TextFormField, 'Meeting title'),
        'Reviewed native meeting',
      );
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await _tap(tester, find.byKey(const ValueKey('meeting-project:null')));
      await _tap(tester, find.text('Release review project').last);
      await _tap(tester, find.byKey(const Key('meeting-add-participant')));
      final person =
          (actions.draft['body']['participants'] as List).single as Map;
      final id = person['participantId'] as String;
      await _enter(
        tester,
        find.byKey(ValueKey('participant-name:$id')),
        'Reviewed participant',
      );
      await _enter(
        tester,
        find.byKey(ValueKey('participant-email:$id')),
        'reviewer@example.test',
      );
      await _tap(
        tester,
        find.byKey(ValueKey('participant-recording:$id:unknown')),
      );
      await _tap(tester, find.text('Granted').last);
      await _tap(
        tester,
        find.text('I reviewed this new meeting and its workspace.'),
      );
      await _tap(tester, find.text('Create reviewed meeting'));
      expect(repository.writes, 1);
      final body = repository.submissions.single.body;
      expect(body['projectId'], 'project:review');
      final saved = (body['participants'] as List).single as Map;
      expect(saved['participantId'], id);
      expect(saved['displayName'], 'Reviewed participant');
      expect(saved['recordingConsent'], 'granted');
      expect(saved['attendeeConsent'], 'unknown');
      expect(saved['response'], 'unknown');
      expect(saved['source'], 'manual');
      expect(saved['consentCapturedAt'], isNotNull);
      expect(actions.recorded?['action'], 'create');
      expect(find.text('Open editor'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      actions.dispose();
    },
    variant: const TargetPlatformVariant({TargetPlatform.linux}),
  );

  testWidgets(
    'participant edits survive protected draft reload without invitation or server submission',
    (tester) async {
      final repository = FakeMeetingsRepository(),
          store = MemoryMeetingDraftStore();
      final first = MeetingActionController(repository, store, meetingTestId);
      final base = Meeting.fromJson(meetingJson());
      await first.initialize();
      await _mount(tester, first, base: base);
      await _tap(tester, find.text('Participant 1: Owner'));
      await _enter(
        tester,
        find.byKey(const ValueKey('participant-name:person-1')),
        'Retained private participant',
      );
      await _tap(
        tester,
        find.byKey(const ValueKey('participant-attendee:person-1:unknown')),
      );
      await _tap(tester, find.text('Pending').last);
      await _tap(tester, find.text('Close draft'));
      await first.flushDraft();
      await tester.pumpWidget(const SizedBox());
      first.dispose();
      final restored = MeetingActionController(
        repository,
        store,
        meetingTestId,
      );
      await restored.initialize();
      await _mount(tester, restored, base: base);
      await _tap(
        tester,
        find.text('Participant 1: Retained private participant'),
      );
      expect(find.text('Retained private participant'), findsOneWidget);
      final person =
          (restored.draft['body']['participants'] as List).single as Map;
      expect(person['participantId'], 'person-1');
      expect(person['attendeeConsent'], 'pending');
      expect(person['recordingConsent'], 'unknown');
      expect(person['consentCapturedAt'], isNotNull);
      expect(repository.writes, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      restored.dispose();
    },
    variant: const TargetPlatformVariant({TargetPlatform.linux}),
  );

  testWidgets(
    'existing source and entity edits preserve exact references and block removal used by a recorded outcome',
    (tester) async {
      final raw = meetingJson(source: true);
      final source = (raw['sourceLinks'] as List).single as Json;
      source['kind'] = 'source_revision';
      source['sourceRevisionId'] = 'source:exact-revision';
      raw['entityLinks'] = [
        {
          'entityId': 'entity:customer',
          'entityType': 'organization',
          'label': 'Customer record',
          'relationship': 'customer',
        },
      ];
      final repository = FakeMeetingsRepository();
      final actions = MeetingActionController(
        repository,
        MemoryMeetingDraftStore(),
        meetingTestId,
      );
      await actions.initialize();
      await _mount(tester, actions, base: Meeting.fromJson(raw));
      await _tap(tester, find.text('Participant 1: Owner'));
      expect(
        tester
            .widget<TextButton>(
              find.byKey(const ValueKey('participant-remove:person-1')),
            )
            .onPressed,
        isNull,
      );
      await _tap(tester, find.text('Recorded evidence'));
      await _enter(
        tester,
        find.byKey(const ValueKey('source-label:source-1')),
        'Reviewed source label',
      );
      expect(
        tester
            .widget<TextButton>(
              find.byKey(const ValueKey('source-remove:source-1')),
            )
            .onPressed,
        isNull,
      );
      await _tap(tester, find.text('Customer record'));
      await _enter(
        tester,
        find.byKey(const ValueKey('entity-label:entity:customer')),
        'Reviewed customer',
      );
      await _tap(
        tester,
        find.byKey(
          const ValueKey('entity-relationship:entity:customer:customer'),
        ),
      );
      await _tap(tester, find.text('Related').last);
      final body = actions.draft['body'] as Map;
      final savedSource = (body['sourceLinks'] as List).single as Map;
      expect(savedSource['sourceId'], source['sourceId']);
      expect(savedSource['sourceRevisionId'], 'source:exact-revision');
      expect(savedSource['label'], 'Reviewed source label');
      final entity = (body['entityLinks'] as List).single as Map;
      expect(entity['entityId'], 'entity:customer');
      expect(entity['entityType'], 'organization');
      expect(entity['relationship'], 'related');
      expect(body['decisions'], raw['decisions']);
      expect(repository.writes, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      actions.dispose();
    },
    variant: const TargetPlatformVariant({TargetPlatform.linux}),
  );

  testWidgets(
    'failed project choice refresh retains a saved project without changing the draft',
    (tester) async {
      var fail = false;
      Future<List<MeetingProjectChoice>> loader(CancelToken _) async {
        if (fail) {
          throw StateError('Unavailable');
        }
        return const [
          MeetingProjectChoice('project:review', 'Release review project'),
        ];
      }

      final repository = FakeMeetingsRepository();
      final actions = MeetingActionController(
        repository,
        MemoryMeetingDraftStore(),
        meetingTestId,
      );
      await actions.initialize();
      await _mount(
        tester,
        actions,
        base: Meeting.fromJson({
          ...meetingJson(),
          'projectId': 'project:review',
        }),
        loader: loader,
      );
      fail = true;
      await _tap(tester, find.byKey(const Key('meeting-refresh-projects')));
      expect(
        find.textContaining('Project choices could not be refreshed'),
        findsOneWidget,
      );
      expect(find.text('Saved project · project:review'), findsOneWidget);
      expect(actions.draft, isEmpty);
      expect(repository.writes, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      actions.dispose();
    },
    variant: const TargetPlatformVariant({TargetPlatform.linux}),
  );

  testWidgets(
    'late project choices and visible draft fields are fenced on current-owner replacement',
    (tester) async {
      final pending = Completer<List<MeetingProjectChoice>>();
      CancelToken? request;
      final repository = FakeMeetingsRepository();
      final actions = MeetingActionController(
        repository,
        MemoryMeetingDraftStore(),
        'new',
      );
      await actions.initialize();
      await _mount(
        tester,
        actions,
        loader: (cancel) {
          request = cancel;
          return pending.future;
        },
      );
      await _enter(
        tester,
        find.widgetWithText(TextFormField, 'Meeting title'),
        'Private earlier draft',
      );
      repository.access.update(null, available: false);
      await tester.pump();
      expect(request!.isCancelled, isTrue);
      pending.complete(const [
        MeetingProjectChoice('project:old', 'Private earlier project'),
      ]);
      await tester.pumpAndSettle();
      expect(find.text('Private earlier draft'), findsNothing);
      expect(find.text('Private earlier project'), findsNothing);
      expect(
        find.textContaining('This private draft is hidden'),
        findsOneWidget,
      );
      repository.access.update(meetingOwner, available: true);
      await tester.pumpAndSettle();
      expect(
        find.textContaining('This private draft is hidden'),
        findsOneWidget,
      );
      expect(find.byType(TextFormField), findsNothing);
      expect(repository.writes, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      actions.dispose();
    },
    variant: const TargetPlatformVariant({TargetPlatform.linux}),
  );

  testWidgets(
    'same-owner controller replacement cannot retain a prior editor or its private fields',
    (tester) async {
      final first = MeetingActionController(
        FakeMeetingsRepository(),
        MemoryMeetingDraftStore(),
        'new',
      );
      final second = MeetingActionController(
        FakeMeetingsRepository(),
        MemoryMeetingDraftStore(),
        'new',
      );
      await first.initialize();
      await second.initialize();
      final current = ValueNotifier(first);
      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            theme: AppTheme.light(),
            home: Scaffold(
              body: ValueListenableBuilder<MeetingActionController>(
                valueListenable: current,
                builder: (context, actions, _) => MeetingEditor(
                  actions: actions,
                  workspaceId: 'workspace:native',
                  stillCurrent: () => actions.available,
                  refresh: () async => true,
                  projectLoader: _projects,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await _enter(
        tester,
        find.widgetWithText(TextFormField, 'Meeting title'),
        'Private replaced-controller draft',
      );
      current.value = second;
      await tester.pumpAndSettle();
      expect(find.text('Private replaced-controller draft'), findsNothing);
      expect(
        find.textContaining('This private draft is hidden'),
        findsOneWidget,
      );
      expect(second.draft, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      current.dispose();
      first.dispose();
      second.dispose();
    },
    variant: const TargetPlatformVariant({TargetPlatform.linux}),
  );
}
