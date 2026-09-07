import 'package:asael/features/meetings/meetings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('decodes meeting schedule, consent, outcomes, and evidence', () {
    final meeting = Meeting.fromJson({
      'meetingId': 'meeting:11111111-1111-4111-8111-111111111111',
      'title': 'Launch review',
      'summary': 'Review go-live evidence.',
      'status': 'scheduled',
      'scheduledStartAt': '2026-09-08T04:00:00.000Z',
      'scheduledEndAt': '2026-09-08T04:30:00.000Z',
      'timezone': 'Asia/Kolkata',
      'effectiveAccessClass': 'project_members',
      'revision': 2,
      'participants': [
        {
          'participantId': 'participant-1',
          'displayName': 'Bennie',
          'role': 'organizer',
          'response': 'accepted',
          'attendeeConsent': 'granted',
          'recordingConsent': 'granted',
        },
      ],
      'decisions': [
        {'decisionId': 'decision-1', 'summary': 'Proceed with release'},
      ],
      'commitments': [
        {'commitmentId': 'commitment-1', 'summary': 'Monitor rollout'},
      ],
      'followUps': [
        {
          'followUpId': 'followup-1',
          'label': 'Publish release notes',
          'status': 'accepted',
        },
      ],
      'sourceLinks': [
        {
          'linkId': 'link-1',
          'label': 'Release brief',
          'kind': 'source_revision',
          'mediaRole': 'reference',
        },
      ],
    });

    expect(meeting.isActive, isTrue);
    expect(meeting.participants.single.recordingConsent, 'granted');
    expect(meeting.decisions.single.label, 'Proceed with release');
    expect(meeting.commitments.single.label, 'Monitor rollout');
    expect(meeting.followUps.single.status, 'accepted');
    expect(meeting.evidence.single.label, 'Release brief');
  });

  test('rejects a meeting without canonical identity and schedule', () {
    expect(
      () => Meeting.fromJson({'title': 'Incomplete'}),
      throwsFormatException,
    );
  });
}
