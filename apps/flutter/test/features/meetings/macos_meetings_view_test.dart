import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/meetings/macos_meetings_view.dart';
import 'package:asael/features/meetings/meetings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _MeetingsRepository implements MeetingsRepository {
  _MeetingsRepository(this.values);

  final List<Meeting> values;

  @override
  Future<Meeting> detail(String id) async =>
      values.firstWhere((meeting) => meeting.id == id);

  @override
  Future<List<Meeting>> list() async => values;
}

Meeting _meeting({
  required String id,
  required String title,
  required DateTime start,
  String summary = '',
  List<MeetingEvidence> evidence = const [],
}) => Meeting(
  id: id,
  title: title,
  summary: summary,
  status: 'scheduled',
  startAt: start,
  endAt: start.add(const Duration(minutes: 45)),
  timezone: 'Asia/Kolkata',
  location: 'Studio',
  accessClass: 'owner_private',
  revision: 2,
  participants: const [],
  decisions: const [],
  commitments: const [],
  followUps: const [],
  evidence: evidence,
);

void main() {
  testWidgets('selects an agenda row and opens its persistent inspector', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1440, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final meetings = [
      _meeting(
        id: 'one',
        title: 'Morning review',
        start: DateTime.utc(2026, 9, 18, 3),
      ),
      _meeting(
        id: 'two',
        title: 'Design review',
        summary: 'Inspect the native workspace.',
        start: DateTime.utc(2026, 9, 18, 5),
        evidence: const [
          MeetingEvidence(
            id: 'evidence-two',
            label: 'Desktop evidence',
            kind: 'source_revision',
            role: 'reference',
          ),
        ],
      ),
    ];
    final controller = MeetingsController(_MeetingsRepository(meetings))
      ..meetings = meetings;
    Meeting? opened;

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: MacosMeetingsView(
          controller: controller,
          onOpen: (meeting) => opened = meeting,
        ),
      ),
    );

    expect(find.text('MEETING BRIEF'), findsOneWidget);
    await tester.tap(find.byKey(const Key('macos-meeting-two')));
    await tester.pump();

    expect(find.text('Desktop evidence'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const Key('macos-meeting-open')));
    await tester.tap(find.byKey(const Key('macos-meeting-open')));
    expect(opened?.id, 'two');
  });

  testWidgets('makes cached agenda state visible after a refresh error', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1440, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final meetings = [
      _meeting(
        id: 'cached',
        title: 'Cached planning call',
        start: DateTime.utc(2026, 9, 18, 3),
      ),
    ];
    final controller = MeetingsController(_MeetingsRepository(meetings))
      ..meetings = meetings
      ..error = StateError('offline');

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: MacosMeetingsView(controller: controller, onOpen: (_) {}),
      ),
    );

    expect(find.text('Cached agenda'), findsOneWidget);
    expect(
      find.text(
        'Showing the last available agenda. The latest refresh did not complete.',
      ),
      findsOneWidget,
    );
    expect(find.text('Cached planning call'), findsNWidgets(2));
  });
}
