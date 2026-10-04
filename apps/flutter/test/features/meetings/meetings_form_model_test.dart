import 'package:asael/features/meetings/meetings.dart';
import 'package:asael/features/meetings/meetings_form_model.dart';
import 'package:asael/features/meetings/meetings_mutations.dart';
import 'package:flutter_test/flutter_test.dart';

import 'meetings_test_support.dart';

Json definition({bool source = false}) =>
    meetingEditableDefinition(Meeting.fromJson(meetingJson(source: source)));
Json participant(Json body) =>
    Map<String, dynamic>.from((body['participants'] as List).single as Map);

void main() {
  test('new participants have unique local identities and no inferred invitation or consent', () {
    final first = newMeetingParticipantDraft(),
        second = newMeetingParticipantDraft();
    expect(first['participantId'], isNot(second['participantId']));
    expect(first, containsPair('source', 'manual'));
    expect(first['response'], 'unknown');
    expect(first['attendeeConsent'], 'unknown');
    expect(first['recordingConsent'], 'unknown');
    expect(first['consentCapturedAt'], isNull);
  });
  test('explicit consent uses canonical time and preserves the exact identity and original capture time', () {
    final original = {...newMeetingParticipantDraft(), 'source': 'calendar'};
    final pending = updateMeetingParticipantDraft(original, {
      'attendeeConsent': 'pending',
    }, now: DateTime.parse('2026-10-04T10:00:00.123456Z'));
    expect(pending['consentCapturedAt'], '2026-10-04T10:00:00.123Z');
    expect(pending['participantId'], original['participantId']);
    expect(pending['source'], 'calendar');
    final granted = updateMeetingParticipantDraft(pending, {
      'recordingConsent': 'granted',
    }, now: DateTime.parse('2026-10-05T12:00:00.000Z'));
    expect(granted['consentCapturedAt'], pending['consentCapturedAt']);
    final reset = updateMeetingParticipantDraft(granted, {
      'attendeeConsent': 'unknown',
      'recordingConsent': 'pending',
    });
    expect(reset['consentCapturedAt'], isNull);
    expect(
      () =>
          updateMeetingParticipantDraft(original, {'participantId': 'another'}),
      throwsFormatException,
    );
  });
  test('recording links require explicit permission from every retained participant', () {
    final body = definition(source: true);
    expect(
      normalizeMeetingEditorDefinition(body)['participants'],
      body['participants'],
    );
    final next = updateMeetingParticipantDraft(participant(body), {
      'recordingConsent': 'pending',
    });
    expect(
      () => normalizeMeetingEditorDefinition({
        ...body,
        'participants': [next],
      }),
      throwsFormatException,
    );
    expect(
      () => normalizeMeetingEditorDefinition({...body, 'participants': []}),
      throwsFormatException,
    );
    expect(next['recordingConsent'], 'pending');
  });
  test('source edits retain exact requested identity and require the right revision and role', () {
    final body = definition();
    final link = {
      'linkId': 'link:one',
      'kind': 'source_revision',
      'sourceId': 'source:one',
      'sourceRevisionId': 'revision:one',
      'mediaRole': 'reference',
      'label': ' Reviewed source ',
    };
    final result = normalizeMeetingEditorDefinition({
      ...body,
      'sourceLinks': [link],
    });
    expect((result['sourceLinks'] as List).single, {
      ...link,
      'label': 'Reviewed source',
    });
    expect(
      () => normalizeMeetingEditorDefinition({
        ...body,
        'sourceLinks': [
          {...link}..remove('sourceRevisionId'),
        ],
      }),
      throwsFormatException,
    );
    expect(
      () => normalizeMeetingEditorDefinition({
        ...body,
        'sourceLinks': [
          {...link, 'kind': 'calendar_event'},
        ],
      }),
      throwsFormatException,
    );
    expect(meetingSourceRoleChoices('capture_recording'), [
      'recording',
      'transcript',
    ]);
    final captured = definition(source: true);
    expect(
      (normalizeMeetingEditorDefinition(captured)['sourceLinks'] as List)
          .single,
      isNot(contains('sourceRevisionSha256')),
    );
  });
  test('collection limits and unique identities apply before a draft can be submitted', () {
    final body = definition(), row = participant(definition());
    expect(
      () => normalizeMeetingEditorDefinition({
        ...body,
        'participants': [row, row],
      }),
      throwsFormatException,
    );
    expect(
      () => normalizeMeetingEditorDefinition({
        ...body,
        'participants': List.filled(251, row),
      }),
      throwsFormatException,
    );
    expect(
      () => normalizeMeetingEditorDefinition({
        ...body,
        'sourceLinks': List.filled(101, {}),
      }),
      throwsFormatException,
    );
    expect(
      () => normalizeMeetingEditorDefinition({
        ...body,
        'entityLinks': List.filled(101, {}),
      }),
      throwsFormatException,
    );
    expect(
      () => normalizeMeetingEditorDefinition({
        ...body,
        'participants': [
          {...row, 'email': 'not an email'},
        ],
      }),
      throwsFormatException,
    );
  });
  test('recorded decisions keep referenced participants and sources from silently disappearing', () {
    final body = definition(source: true);
    expect(
      meetingRelationshipReferenced(body, 'ownerParticipantId', 'person-1'),
      isTrue,
    );
    expect(
      meetingRelationshipReferenced(body, 'sourceLinkId', 'source-1'),
      isTrue,
    );
    expect(
      () => normalizeMeetingEditorDefinition({...body, 'sourceLinks': []}),
      throwsFormatException,
    );
    expect(
      () => normalizeMeetingEditorDefinition({
        ...definition(),
        'participants': [],
      }),
      throwsFormatException,
    );
    expect(
      normalizeMeetingEditorDefinition(body)['decisions'],
      body['decisions'],
    );
  });
  test('entity label and relationship edits preserve exact registry identity and type', () {
    final entity = {
      'entityId': 'entity:customer',
      'entityType': 'organization',
      'label': ' Customer ',
      'relationship': 'customer',
    };
    final body = {
      ...definition(),
      'entityLinks': [entity],
    };
    expect(
      (normalizeMeetingEditorDefinition(body)['entityLinks'] as List).single,
      {...entity, 'label': 'Customer'},
    );
    expect(
      () => normalizeMeetingEditorDefinition({
        ...body,
        'entityLinks': [
          {...entity, 'relationship': 'send'},
        ],
      }),
      throwsFormatException,
    );
    expect(
      () => normalizeMeetingEditorDefinition({
        ...body,
        'entityLinks': [
          {...entity, 'entityType': 'invented'},
        ],
      }),
      throwsFormatException,
    );
  });
  test(
    'project access and actual time pairs retain their server contract meaning',
    () {
      final body = {...definition(), 'declaredAccessClass': 'project_members'};
      expect(
        () => normalizeMeetingEditorDefinition(body),
        throwsFormatException,
      );
      expect(
        normalizeMeetingEditorDefinition({
          ...body,
          'projectId': 'project:exact',
        })['projectId'],
        'project:exact',
      );
      expect(
        () => normalizeMeetingEditorDefinition({
          ...definition(),
          'actualStartAt': '2026-10-04T10:00:00.000Z',
        }),
        throwsFormatException,
      );
      expect(
        () => normalizeMeetingEditorDefinition({
          ...definition(),
          'actualStartAt': '2026-10-04T10:00:00.000Z',
          'actualEndAt': '2026-10-04T09:00:00.000Z',
        }),
        throwsFormatException,
      );
    },
  );
}
