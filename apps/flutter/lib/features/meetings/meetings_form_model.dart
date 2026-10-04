import 'meetings.dart';
import 'meetings_mutations.dart';
import 'meetings_validation.dart';

const meetingParticipantRoles = ['organizer', 'required', 'optional', 'guest'];
const meetingParticipantResponses = [
  'accepted',
  'declined',
  'tentative',
  'needs_action',
  'unknown',
];
const meetingAttendeeConsentStates = [
  'granted',
  'declined',
  'pending',
  'unknown',
];
const meetingRecordingConsentStates = [
  'granted',
  'declined',
  'pending',
  'not_required',
  'unknown',
];
const meetingEntityRelationships = [
  'customer',
  'account',
  'participant',
  'subject',
  'related',
];

Json newMeetingParticipantDraft() => {
  'participantId': 'meeting-participant:${newMeetingMutationKey()}',
  'displayName': '',
  'email': null,
  'entityId': null,
  'role': 'required',
  'response': 'unknown',
  'attendeeConsent': 'unknown',
  'recordingConsent': 'unknown',
  'consentCapturedAt': null,
  'source': 'manual',
};

Json updateMeetingParticipantDraft(
  Json previous,
  Json change, {
  DateTime? now,
}) {
  meetingRequire(
    change.keys.every(
      const {
        'displayName',
        'email',
        'role',
        'response',
        'attendeeConsent',
        'recordingConsent',
      }.contains,
    ),
    'Participant identity and provenance cannot be reassigned.',
  );
  final next = {...previous, ...change};
  if (change.containsKey('attendeeConsent') ||
      change.containsKey('recordingConsent')) {
    final attendee = meetingMember(
      next['attendeeConsent'],
      meetingAttendeeConsentStates,
    );
    final recording = meetingMember(
      next['recordingConsent'],
      meetingRecordingConsentStates,
    );
    final captured =
        attendee != 'unknown' ||
        !const ['unknown', 'pending'].contains(recording);
    final instant = now ?? DateTime.now();
    next['consentCapturedAt'] = captured
        ? previous['consentCapturedAt'] ??
              DateTime.fromMillisecondsSinceEpoch(
                instant.millisecondsSinceEpoch,
                isUtc: true,
              ).toIso8601String()
        : null;
  }
  return next;
}

List<String> meetingSourceRoleChoices(String kind) => switch (kind) {
  'calendar_event' => const ['calendar'],
  'capture_recording' => const ['recording', 'transcript'],
  _ => meetingMediaRoles,
};

bool meetingRelationshipReferenced(Json definition, String field, String id) =>
    ['decisions', 'commitments'].any(
      (collection) => (definition[collection] as List).any(
        (value) => meetingMap(value)[field] == id,
      ),
    );

String _id(Object? value) => meetingId(value, max: 240);
String? _nullableId(Object? value) => value == null ? null : _id(value);
String _text(Object? value, int maximum) =>
    meetingText(value, max: maximum).trim();

/// Validates only the existing Meeting draft contract. References are still
/// resolved and authorized by the server when the controller submits the draft.
Json normalizeMeetingEditorDefinition(Json value) {
  final participants = meetingList(value['participants'], 250, (row) {
    final email = row['email'] == null ? null : _text(row['email'], 320);
    meetingRequire(
      email == null || RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(email),
      'Enter a valid participant email or leave it empty.',
    );
    final result = {
      ...row,
      'participantId': _id(row['participantId']),
      'displayName': _text(row['displayName'], 160),
      'email': email,
      'entityId': _nullableId(row['entityId']),
    };
    MeetingParticipant.fromJson(result);
    return result;
  });
  final sources = meetingList(value['sourceLinks'], 100, (row) {
    final kind = meetingMember(row['kind'], meetingSourceKinds);
    meetingMember(row['mediaRole'], meetingSourceRoleChoices(kind));
    if (kind == 'calendar_event' || kind == 'source_revision') {
      _id(row['sourceRevisionId']);
    } else if (row['sourceRevisionId'] != null) {
      _id(row['sourceRevisionId']);
    }
    return {
      ...row,
      'linkId': _id(row['linkId']),
      'sourceId': _id(row['sourceId']),
      'label': _text(row['label'], 240),
    };
  });
  final entities = meetingList(value['entityLinks'], 100, (row) {
    meetingMember(row['entityType'], const [
      'person',
      'organization',
      'account',
      'project',
    ]);
    meetingMember(row['relationship'], meetingEntityRelationships);
    return {
      ...row,
      'entityId': _id(row['entityId']),
      'label': _text(row['label'], 240),
    };
  });
  meetingUnique(participants.map((row) => row['participantId'] as String));
  meetingUnique(sources.map((row) => row['linkId'] as String));
  meetingUnique(entities.map((row) => row['entityId'] as String));
  meetingRequire(
    sources.where((row) => row['kind'] == 'calendar_event').length <= 1,
    'A Meeting can link one exact Calendar event.',
  );
  final access = meetingMember(
    value['declaredAccessClass'],
    meetingAccessClasses,
  );
  final project = _nullableId(value['projectId']);
  meetingRequire(
    access != 'project_members' || project != null,
    'Choose a project before using project member access.',
  );
  if (sources.any(
    (row) =>
        row['kind'] == 'capture_recording' || row['mediaRole'] == 'recording',
  )) {
    meetingRequire(
      participants.isNotEmpty &&
          participants.every(
            (row) => const [
              'granted',
              'not_required',
            ].contains(row['recordingConsent']),
          ),
      'Every participant must explicitly permit recording before recording media is linked.',
    );
  }
  final participantIds = participants
      .map((row) => row['participantId'])
      .toSet();
  final sourceIds = sources.map((row) => row['linkId']).toSet();
  for (final collection in ['decisions', 'commitments']) {
    for (final row in meetingList(value[collection], 250, (row) => row)) {
      meetingRequire(
        row['ownerParticipantId'] == null ||
            participantIds.contains(row['ownerParticipantId']),
        'A recorded decision or commitment still references a removed participant.',
      );
      meetingRequire(
        row['sourceLinkId'] == null || sourceIds.contains(row['sourceLinkId']),
        'A recorded decision or commitment still references a removed source.',
      );
    }
  }
  final actualStart = meetingNullableDate(value['actualStartAt']);
  final actualEnd = meetingNullableDate(value['actualEndAt']);
  meetingRequire(
    (actualStart == null) == (actualEnd == null) &&
        (actualStart == null || actualEnd!.isAfter(actualStart)),
    'Actual start and end must be recorded together, with the end after the start.',
  );
  return {
    ...value,
    'projectId': project,
    'participants': participants,
    'sourceLinks': sources,
    'entityLinks': entities,
  };
}
