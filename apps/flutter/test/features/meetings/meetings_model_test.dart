import 'package:asael/features/meetings/meetings.dart';
import 'package:asael/features/meetings/meetings_snapshots.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_test_support.dart';

void main() {
  test('requires exact revision, consent and source provenance without defaulting missing metadata', () {
    final meeting = Meeting.fromJson(meetingJson(source: true));
    expect(meeting.revisionId, '$meetingTestId:v2');
    expect(meeting.participants.single.recordingConsent, 'granted');
    expect(Meeting.fromJson(meetingJson()).recordingConsentConfirmed, isFalse);
    expect(meeting.evidence.single.revisionSha256, meetingDigest);
    expect(
      () => Meeting.fromJson(meetingJson()..remove('participants')),
      throwsFormatException,
    );
    expect(
      () => Meeting.fromJson(meetingJson()..['revision'] = 3),
      throwsFormatException,
    );
    expect(
      () => Meeting.fromJson(
        meetingJson()..['scheduledStartAt'] = '2026-02-31T10:00:00.000Z',
      ),
      throwsFormatException,
    );
  });
  test(
    'rejects duplicate identities, fabricated consent and wider linked access',
    () {
      final duplicate = meetingJson();
      (duplicate['participants'] as List).add(
        (duplicate['participants'] as List).first,
      );
      expect(() => Meeting.fromJson(duplicate), throwsFormatException);
      final consent = meetingJson();
      consent['participants'][0]['recordingConsent'] = 'granted';
      expect(() => Meeting.fromJson(consent), throwsFormatException);
      expect(
        () => Meeting.fromJson(
          meetingJson(source: true)
            ..['effectiveAccessClass'] = 'workspace_members',
        ),
        throwsFormatException,
      );
    },
  );
  test(
    'detail rejects wrong target, missing projections and changed raw evidence',
    () {
      expect(
        () => MeetingDetailSnapshot.parse(
          meetingDetailJson(),
          id: meetingOtherId,
          tenantId: meetingOwner.tenantId,
        ),
        throwsFormatException,
      );
      final missing = meetingDetailJson(pending: true)..['linkedSources'] = [];
      expect(
        () => MeetingDetailSnapshot.parse(
          missing,
          id: meetingTestId,
          tenantId: meetingOwner.tenantId,
        ),
        throwsFormatException,
      );
      final changed = meetingDetailJson(pending: true);
      changed['linkedSources'][0]['revisionState'] = 'changed';
      expect(
        () => MeetingDetailSnapshot.parse(
          changed,
          id: meetingTestId,
          tenantId: meetingOwner.tenantId,
        ),
        throwsFormatException,
      );
      expect(meetingDetail(pending: true).sources.single.transcript, '');
    },
  );
  test('list requires declared coverage and exact tenant/workspace, preserving true empty', () {
    expect(
      () => MeetingsSnapshot.parse({
        'context': meetingContextJson(),
      }, tenantId: meetingOwner.tenantId),
      throwsFormatException,
    );
    expect(
      () => MeetingsSnapshot.parse({
        'context': meetingContextJson(),
        'meetings': [meetingJson()],
      }, tenantId: 'foreign'),
      throwsFormatException,
    );
    expect(
      MeetingsSnapshot.parse({
        'context': meetingContextJson(),
        'meetings': [],
      }, tenantId: meetingOwner.tenantId).meetings,
      isEmpty,
    );
  });
}
