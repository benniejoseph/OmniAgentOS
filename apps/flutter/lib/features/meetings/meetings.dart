import 'package:flutter/foundation.dart';

import 'meetings_validation.dart';

export 'meetings_controller.dart';

typedef Json = Map<String, dynamic>;

class MeetingParticipant {
  const MeetingParticipant({
    required this.id,
    required this.name,
    required this.role,
    required this.response,
    required this.attendeeConsent,
    required this.recordingConsent,
    this.email,
    this.entityId,
    this.consentCapturedAt,
    this.source,
  });
  final String id, name, role, response, attendeeConsent, recordingConsent;
  final String? email, entityId, source;
  final DateTime? consentCapturedAt;
  factory MeetingParticipant.fromJson(Json json) {
    final attendee = meetingMember(json['attendeeConsent'], const [
      'granted',
      'declined',
      'pending',
      'unknown',
    ]);
    final recording = meetingMember(json['recordingConsent'], const [
      'granted',
      'declined',
      'pending',
      'not_required',
      'unknown',
    ]);
    final captured = meetingNullableDate(json['consentCapturedAt']);
    meetingRequire(
      (attendee != 'unknown' ||
              !const ['unknown', 'pending'].contains(recording)) ==
          (captured != null),
    );
    return MeetingParticipant(
      id: meetingId(json['participantId']),
      name: meetingText(json['displayName'], max: 160),
      role: meetingMember(json['role'], const [
        'organizer',
        'required',
        'optional',
        'guest',
      ]),
      response: meetingMember(json['response'], const [
        'accepted',
        'declined',
        'tentative',
        'needs_action',
        'unknown',
      ]),
      attendeeConsent: attendee,
      recordingConsent: recording,
      email: meetingNullableText(json['email'], max: 320),
      entityId: meetingNullableId(json['entityId']),
      consentCapturedAt: captured,
      source: meetingMember(json['source'], const ['calendar', 'manual']),
    );
  }
}

class MeetingEvidence {
  const MeetingEvidence({
    required this.id,
    required this.label,
    required this.kind,
    required this.role,
    this.sourceId,
    this.revisionId,
    this.revisionSha256,
    this.authoritySha256,
    this.accessClass,
  });
  final String id, label, kind, role;
  final String? sourceId,
      revisionId,
      revisionSha256,
      authoritySha256,
      accessClass;
  factory MeetingEvidence.fromJson(Json json) => MeetingEvidence(
    id: meetingId(json['linkId']),
    label: meetingText(json['label'], max: 240),
    kind: meetingMember(json['kind'], meetingSourceKinds),
    role: meetingMember(json['mediaRole'], meetingMediaRoles),
    sourceId: meetingId(json['sourceId']),
    revisionId: meetingId(json['sourceRevisionId']),
    revisionSha256: meetingHash(json['sourceRevisionSha256']),
    authoritySha256: meetingHash(json['sourceAuthoritySha256']),
    accessClass: meetingMember(json['accessClass'], meetingAccessClasses),
  );
}

class MeetingNote {
  const MeetingNote({
    required this.id,
    required this.label,
    this.status,
    this.ownerParticipantId,
    this.sourceLinkId,
    this.dueAt,
    this.workItemId,
    this.draftId,
    this.commitmentId,
  });
  final String id, label;
  final String? status,
      ownerParticipantId,
      sourceLinkId,
      workItemId,
      draftId,
      commitmentId;
  final DateTime? dueAt;
}

/// An immutable server revision. Optional constructor fields preserve embedded
/// presenters; the network factory requires the complete public contract.
@immutable
class Meeting {
  const Meeting({
    required this.id,
    required this.title,
    required this.summary,
    required this.status,
    required this.startAt,
    required this.endAt,
    required this.timezone,
    required this.location,
    required this.accessClass,
    required this.revision,
    required this.participants,
    required this.decisions,
    required this.commitments,
    required this.followUps,
    required this.evidence,
    this.projectId,
    this.tenantId,
    this.workspaceId,
    this.ownerActorId,
    this.revisionId,
    this.sha256,
    this.consentSha256,
    this.revisedAt,
    this.actualStartAt,
    this.actualEndAt,
    this.raw,
  });
  final String id, title, summary, status, timezone, location, accessClass;
  final DateTime startAt, endAt;
  final DateTime? revisedAt, actualStartAt, actualEndAt;
  final int revision;
  final String? projectId,
      tenantId,
      workspaceId,
      ownerActorId,
      revisionId,
      sha256,
      consentSha256;
  final List<MeetingParticipant> participants;
  final List<MeetingNote> decisions, commitments, followUps;
  final List<MeetingEvidence> evidence;
  final Json? raw;
  bool get isActive => status == 'scheduled' || status == 'in_progress';
  String get versionKey => '$id\u0000$revision\u0000${sha256 ?? ''}';
  bool get recordingConsentConfirmed =>
      participants.isNotEmpty &&
      participants.every(
        (person) =>
            const ['granted', 'not_required'].contains(person.recordingConsent),
      );

  factory Meeting.fromJson(Json json) {
    meetingRequire(json['schemaVersion'] == 1);
    final id = meetingId(json['meetingId']);
    meetingRequire(
      RegExp(
        r'^meeting:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      ).hasMatch(id),
    );
    final revision = meetingInt(json['revision'], minimum: 1);
    meetingRequire(
      json['meetingRevisionId'] == '$id:v$revision' &&
          json['previousMeetingRevisionId'] ==
              (revision == 1 ? null : '$id:v${revision - 1}'),
    );
    final start = meetingDate(json['scheduledStartAt']),
        end = meetingDate(json['scheduledEndAt']);
    meetingRequire(end.isAfter(start));
    final actualStart = meetingNullableDate(json['actualStartAt']),
        actualEnd = meetingNullableDate(json['actualEndAt']);
    meetingRequire(
      (actualStart == null) == (actualEnd == null) &&
          (actualStart == null || actualEnd!.isAfter(actualStart)),
    );
    final people = meetingList(
      json['participants'],
      250,
      MeetingParticipant.fromJson,
    );
    meetingUnique(people.map((person) => person.id));
    final sources = meetingList(
      json['sourceLinks'],
      100,
      MeetingEvidence.fromJson,
    );
    meetingUnique(sources.map((source) => source.id));
    meetingRequire(
      sources.where((source) => source.kind == 'calendar_event').length <= 1,
    );
    if (sources.any(
      (source) =>
          source.kind == 'capture_recording' || source.role == 'recording',
    )) {
      meetingRequire(
        people.isNotEmpty &&
            people.every(
              (person) => const [
                'granted',
                'not_required',
              ].contains(person.recordingConsent),
            ),
      );
    }
    final declared = meetingMember(
          json['declaredAccessClass'],
          meetingAccessClasses,
        ),
        effective = meetingMember(
          json['effectiveAccessClass'],
          meetingAccessClasses,
        );
    meetingRequire(declared != 'project_members' || json['projectId'] != null);
    final accessRanks = [
      meetingAccessClasses.indexOf(declared),
      ...sources.map(
        (source) => meetingAccessClasses.indexOf(source.accessClass!),
      ),
    ];
    meetingRequire(
      meetingAccessClasses.indexOf(effective) ==
          accessRanks.reduce((a, b) => a < b ? a : b),
    );
    final decisions = meetingList(
      json['decisions'],
      250,
      (value) => MeetingNote(
        id: meetingId(value['decisionId']),
        label: meetingText(value['summary'], max: 2000),
        ownerParticipantId: meetingNullableId(value['ownerParticipantId']),
        sourceLinkId: meetingNullableId(value['sourceLinkId']),
      ),
    );
    final commitments = meetingList(
      json['commitments'],
      250,
      (value) => MeetingNote(
        id: meetingId(value['commitmentId']),
        label: meetingText(value['summary'], max: 2000),
        ownerParticipantId: meetingNullableId(value['ownerParticipantId']),
        sourceLinkId: meetingNullableId(value['sourceLinkId']),
        dueAt: meetingNullableDate(value['dueAt']),
      ),
    );
    final followUps = meetingList(
      json['followUps'],
      250,
      (value) => MeetingNote(
        id: meetingId(value['followUpId']),
        label: meetingText(value['label'], max: 500),
        status: meetingMember(value['status'], const [
          'proposed',
          'accepted',
          'completed',
          'dismissed',
        ]),
        workItemId: meetingNullableId(value['workItemId']),
        draftId: meetingNullableId(value['draftId']),
        commitmentId: meetingNullableId(value['commitmentId']),
      ),
    );
    for (final notes in [decisions, commitments, followUps]) {
      meetingUnique(notes.map((note) => note.id));
    }
    for (final followUp in followUps) {
      meetingRequire(
        followUp.commitmentId == null ||
            commitments.any((item) => item.id == followUp.commitmentId),
      );
    }
    for (final note in [...decisions, ...commitments]) {
      meetingRequire(
        note.ownerParticipantId == null ||
            people.any((person) => person.id == note.ownerParticipantId),
      );
      meetingRequire(
        note.sourceLinkId == null ||
            sources.any((source) => source.id == note.sourceLinkId),
      );
    }
    meetingList(json['entityLinks'], 100, (value) {
      meetingId(value['entityId']);
      meetingText(value['label'], max: 240);
      meetingMember(value['entityType'], const [
        'person',
        'organization',
        'account',
        'project',
      ]);
      meetingMember(value['relationship'], const [
        'customer',
        'account',
        'participant',
        'subject',
        'related',
      ]);
      return value;
    });
    final owner = meetingId(json['ownerActorId']);
    meetingRequire(RegExp(r'^actor:[0-9a-f-]{36}$').hasMatch(owner));
    meetingId(json['revisedByActorId']);
    final workspace = meetingId(json['workspaceId']);
    meetingRequire(workspace.startsWith('workspace:'));
    return Meeting(
      id: id,
      title: meetingText(json['title'], max: 240),
      summary: meetingText(json['summary'], max: 8000, empty: true),
      status: meetingMember(json['status'], const [
        'scheduled',
        'in_progress',
        'completed',
        'cancelled',
      ]),
      startAt: start,
      endAt: end,
      timezone: meetingText(json['timezone'], max: 100),
      location: meetingText(json['location'], max: 500, empty: true),
      accessClass: effective,
      revision: revision,
      participants: people,
      decisions: decisions,
      commitments: commitments,
      followUps: followUps,
      evidence: sources,
      projectId: meetingNullableId(json['projectId']),
      tenantId: meetingId(json['tenantId']),
      workspaceId: workspace,
      ownerActorId: owner,
      revisionId: json['meetingRevisionId'] as String,
      sha256: meetingHash(json['meetingSha256']),
      consentSha256: meetingHash(json['consentSnapshotSha256']),
      revisedAt: meetingDate(json['revisedAt']),
      actualStartAt: meetingNullableDate(json['actualStartAt']),
      actualEndAt: meetingNullableDate(json['actualEndAt']),
      raw: freezeMeeting(json) as Json,
    );
  }
}

/// Production uses the cancellable scoped snapshot extension. This small
/// interface remains compatible with existing embedded/native presenters.
abstract interface class MeetingsRepository {
  Future<List<Meeting>> list();
  Future<Meeting> detail(String id);
}
