import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';

import 'meetings.dart';
import 'meetings_access.dart';
import 'meetings_commitments.dart';
import 'meetings_snapshots.dart';
import 'meetings_validation.dart';

const meetingWriteOperations = {
  'create': 'meetings.create',
  'update': 'meetings.update',
  'propose': 'meetings.commitments.propose',
  'resolve': 'meetings.commitments.resolve',
};

Object? _sorted(Object? value) {
  if (value is Map) {
    final row = meetingMap(value), keys = row.keys.toList()..sort();
    return {for (final key in keys) key: _sorted(row[key])};
  }
  if (value is List) {
    return value.map(_sorted).toList();
  }
  if (value is double &&
      value == value.truncateToDouble() &&
      value.abs() <= 9007199254740991) {
    return value.toInt();
  }
  return value;
}

String meetingCanonicalJson(Object? value) => jsonEncode(_sorted(value));
Future<String> meetingSha(Object? value) =>
    meetingShaText(meetingCanonicalJson(value));
Future<String> meetingShaText(String value) async =>
    (await Sha256().hash(utf8.encode(value))).bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
Future<void> verifyMeetingDigest(Json value, String field) async {
  final body = {...value}..remove(field);
  meetingRequire(
    meetingHash(value[field]) == await meetingSha(body),
    'An immutable Meeting record does not match its digest.',
  );
}

Future<void> verifyMeetingRevision(Meeting value) async {
  final row = value.raw;
  meetingRequire(row != null);
  await verifyMeetingDigest(row!, 'meetingSha256');
  final consent = [
    for (final participant in value.participants)
      {
        'participantId': participant.id,
        'attendeeConsent': participant.attendeeConsent,
        'recordingConsent': participant.recordingConsent,
        'consentCapturedAt': participant.consentCapturedAt
            ?.toUtc()
            .toIso8601String(),
      },
  ];
  meetingRequire(
    value.consentSha256 == await meetingSha(consent),
    'The consent snapshot does not match its exact participants.',
  );
}

String newMeetingMutationKey() {
  final random = Random.secure(),
      bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final hex = bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

class MeetingSubmission {
  MeetingSubmission._(
    this.action,
    this.id,
    this.key,
    this.ownerKey,
    this.body,
    this.evidence,
  );
  final String action, key, ownerKey;
  final String? id;
  final Json body, evidence;
  bool get replaySupported => action == 'create' || action == 'update';
  String get operation => meetingWriteOperations[action]!;
  Json get json => {
    'action': action,
    'id': id,
    'key': key,
    'ownerKey': ownerKey,
    'body': body,
    'evidence': evidence,
  };
  factory MeetingSubmission.freeze({
    required String action,
    required MeetingsOwner owner,
    required Json body,
    String? id,
    Json evidence = const {},
    String? key,
  }) {
    meetingRequire(meetingWriteOperations.containsKey(action));
    if (action != 'create') {
      meetingId(id);
    }
    meetingRequire(!body.containsKey('meetingId'));
    meetingId(body['workspaceId']);
    if (action == 'update') {
      meetingInt(body['expectedRevision'], minimum: 1);
    }
    if (action == 'propose') {
      meetingId(body['mediaRevisionId']);
      meetingId(body['actionItemId']);
    }
    if (action == 'resolve') {
      meetingId(body['proposalId']);
      meetingHash(body['expectedProposalSha256']);
      final decision = meetingMember(body['decision'], const [
        'confirmed',
        'dismissed',
      ]);
      if (decision == 'dismissed') {
        meetingRequire(
          body.keys.every(
            const {
              'workspaceId',
              'proposalId',
              'expectedProposalSha256',
              'decision',
            }.contains,
          ),
        );
      } else {
        meetingId(body['ownerParticipantId']);
        meetingRequire(
          body.containsKey('dueAt'),
          'Review an explicit due date or no due date.',
        );
        if (body['dueAt'] != null) {
          meetingDate(body['dueAt']);
        }
      }
    }
    final mutationKey = key ?? newMeetingMutationKey();
    meetingText(mutationKey, max: 512);
    return MeetingSubmission._(
      action,
      id,
      mutationKey,
      owner.key,
      freezeMeeting(body) as Json,
      freezeMeeting(evidence) as Json,
    );
  }
  factory MeetingSubmission.restore(Json value, MeetingsOwner owner) {
    meetingRequire(value['ownerKey'] == owner.key);
    return MeetingSubmission.freeze(
      action: meetingText(value['action']),
      id: value['id'] as String?,
      owner: owner,
      body: meetingMap(value['body']),
      evidence: meetingMap(value['evidence']),
      key: meetingText(value['key'], max: 512),
    );
  }
}

class MeetingAcceptedReceipt {
  MeetingAcceptedReceipt(
    this.submitted,
    this.raw, {
    this.meeting,
    this.commitment,
    this.draft,
  });
  final MeetingSubmission submitted;
  final Json raw;
  final Meeting? meeting;
  final MeetingCommitmentReview? commitment;
  final Json? draft;
  String get receiptSha256 =>
      (raw['serviceReceipt'] as Map)['receiptSha256'] as String;
  String get targetId => meeting?.id ?? submitted.id!;
  static Future<MeetingAcceptedReceipt> parse(
    Json value,
    MeetingSubmission submitted,
    MeetingsOwner owner,
  ) async {
    meetingRequire(submitted.ownerKey == owner.key);
    final service = meetingMap(value['serviceReceipt']),
        context = MeetingContext.parse(value['context']);
    meetingRequire(context.workspaceId == submitted.body['workspaceId']);
    final operation = 'app.${submitted.operation}',
        propose = submitted.action == 'propose',
        resolve = submitted.action == 'resolve';
    final event = propose
        ? 'meeting-commitment-events.v1'
        : resolve
        ? 'meeting-commitment-events.v1+projects.atomic-events.v1+governed-communication-events.v1'
        : 'meeting-events.v1';
    meetingRequire(
      service['schemaVersion'] == 1 &&
          service['receiptKind'] == 'app_service_receipt' &&
          service['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
          service['operation'] == operation &&
          service['action'] == (propose ? 'run.agent' : 'manage.workflow') &&
          service['resourceType'] ==
              (propose || resolve ? 'meeting_commitment' : 'meeting') &&
          service['accessMode'] == 'mutation' &&
          service['eventContract'] == event,
    );
    meetingHash(service['authoritySha256']);
    meetingInt(service['resourceCount'], maximum: 1000000);
    meetingInstant(service['occurredAt']);
    meetingRequire(
      service['idempotencyKeySha256'] ==
          await meetingShaText('${owner.tenantId}\u0000${submitted.key}'),
      'The receipt is not bound to the submitted key.',
    );
    final responseBody = {...value}..remove('serviceReceipt'),
        serviceBody = {...service}..remove('receiptSha256');
    meetingRequire(
      service['outcomeSha256'] == await meetingSha(responseBody) &&
          service['receiptSha256'] == await meetingSha(serviceBody),
      'The receipt does not describe the exact returned response.',
    );
    Meeting? meeting;
    MeetingCommitmentReview? commitment;
    Json? draft;
    if (!propose && !resolve) {
      meeting = Meeting.fromJson(meetingMap(value['meeting']));
      await verifyMeetingRevision(meeting);
      meetingRequire(
        meeting.tenantId == owner.tenantId &&
            meeting.workspaceId == context.workspaceId &&
            meeting.ownerActorId == 'actor:${owner.userId}',
      );
      if (submitted.action == 'update') {
        meetingRequire(
          meeting.id == submitted.id &&
              meeting.revision == submitted.body['expectedRevision'] + 1,
        );
      }
      for (final entry in submitted.body.entries) {
        if (const [
          'workspaceId',
          'expectedRevision',
          'sourceLinks',
        ].contains(entry.key)) {
          continue;
        }
        meetingRequire(
          meetingCanonicalJson(meeting.raw![entry.key]) ==
              meetingCanonicalJson(entry.value),
          'The saved meeting does not match the exact submitted fields.',
        );
      }
      final requested = meetingList(
        submitted.body['sourceLinks'],
        100,
        (row) => row,
      );
      meetingRequire(requested.length == meeting.evidence.length);
      for (final link in requested) {
        final matches = meeting.evidence
            .where((item) => item.id == link['linkId'])
            .toList();
        meetingRequire(matches.length == 1);
        final saved = matches.single;
        meetingRequire(
          saved.kind == link['kind'] &&
              saved.sourceId == link['sourceId'] &&
              saved.label == link['label'] &&
              saved.role == link['mediaRole'] &&
              (link['sourceRevisionId'] == null ||
                  saved.revisionId == link['sourceRevisionId']),
        );
      }
      MeetingDetailSnapshot.parse(
        value,
        id: meeting.id,
        tenantId: owner.tenantId,
        workspaceId: context.workspaceId,
      );
    } else {
      commitment = MeetingCommitmentReview.parse(
        meetingMap(value['commitment']),
        meetingIdValue: submitted.id!,
        tenantId: owner.tenantId,
        workspaceId: context.workspaceId,
      );
      await verifyMeetingDigest(commitment.proposal, 'proposalSha256');
      if (commitment.resolution != null) {
        await verifyMeetingDigest(commitment.resolution!, 'resolutionSha256');
      }
      if (propose) {
        meetingRequire(
          commitment.mediaRevisionId == submitted.body['mediaRevisionId'] &&
              commitment.proposal['actionItemId'] ==
                  submitted.body['actionItemId'],
        );
        for (final field in [
          'mediaOutputSha256',
          'actionItemSha256',
          'sourceLinkId',
          'recordingId',
        ]) {
          if (submitted.evidence[field] != null) {
            meetingRequire(
              commitment.proposal[field] == submitted.evidence[field],
            );
          }
        }
      } else {
        final resolution = commitment.resolution;
        meetingRequire(
          commitment.id == submitted.body['proposalId'] &&
              commitment.sha256 == submitted.body['expectedProposalSha256'] &&
              resolution != null &&
              resolution['decision'] == submitted.body['decision'],
        );
        meetingRequire(
          resolution!['resolvedByActorId'] == 'actor:${owner.userId}',
          'The resolution receipt belongs to a different current owner.',
        );
        final reconciliation = commitment.reconciliation;
        if (reconciliation != null) {
          final communication = submitted.body['communication'];
          final requestedCommunication = communication == null
              ? null
              : meetingMap(communication);
          final request = submitted.body['decision'] == 'dismissed'
              ? {'decision': 'dismissed'}
              : {
                  'decision': 'confirmed',
                  'ownerParticipantId': submitted.body['ownerParticipantId'],
                  'dueAt': submitted.body.containsKey('dueAt')
                      ? submitted.body['dueAt']
                      : meetingMap(commitment.proposal['dueDate'])['dueAt'],
                  'communication': requestedCommunication == null
                      ? null
                      : {
                          ...requestedCommunication,
                          'connectionId':
                              requestedCommunication['connectionId'],
                          'subject': meetingText(
                            requestedCommunication['subject'],
                            max: 998,
                          ).trim(),
                          'body': meetingText(
                            requestedCommunication['body'],
                            max: 50000,
                          ).trim(),
                        },
                };
          final expected = await meetingSha({
            'schemaVersion': 1,
            'contract': 'meeting-commitment-resolution-intent:1',
            'tenantId': owner.tenantId,
            'workspaceId': context.workspaceId,
            'meetingId': submitted.id,
            'proposalId': commitment.id,
            'proposalSha256': commitment.sha256,
            'ownerActorId': 'actor:${owner.userId}',
            'request': request,
          });
          meetingRequire(
            reconciliation['requestSha256'] == expected,
            'The resolution receipt belongs to a different reviewed decision.',
          );
        } else {
          // Older accepted records remain readable, but cannot prove which
          // participant was selected for a newly submitted communication.
          meetingRequire(
            submitted.body['communication'] == null,
            'The exact recipient decision is not recorded in this receipt.',
          );
        }
        if (submitted.body['decision'] == 'confirmed') {
          meetingRequire(
            resolution['ownerParticipantId'] ==
                    submitted.body['ownerParticipantId'] &&
                resolution['dueAt'] == submitted.body['dueAt'],
          );
          final communication = submitted.body['communication'];
          if (communication == null) {
            meetingRequire(
              resolution['draftId'] == null && value['draft'] == null,
            );
          } else {
            final request = meetingMap(communication);
            meetingRequire(
              resolution['communicationPolicyId'] == request['policyId'] &&
                  resolution['draftId'] != null,
            );
            // A draft identity alone cannot prove exact recipient or content.
            draft = meetingMap(value['draft']);
            meetingRequire(
              draft['id'] == resolution['draftId'] &&
                  draft['policyId'] == request['policyId'] &&
                  draft['channel'] == 'email' &&
                  draft['recipient'] == submitted.evidence['recipientEmail'] &&
                  draft['subject'] == request['subject'] &&
                  draft['body'] == request['body'] &&
                  draft['googleConnectionId'] == request['connectionId'],
            );
            meetingRequire(
              draft['version'] == 'p9.14-governed-communication:1' &&
                  draft['senderIdentity'] == 'connected_account',
            );
            meetingId(draft['intentId']);
            meetingText(draft['recipient'], max: 500);
            meetingText(draft['subject'], max: 998);
            meetingText(draft['body'], max: 50000);
            meetingInstant(draft['createdAt']);
            meetingMember(draft['state'], const [
              'ready',
              'delivering',
              'delivered',
              'failed',
              'canceled',
            ]);
            meetingHash(draft['draftSha256']);
            meetingInt(draft['lifecycleRevision'], minimum: 1);
            meetingInstant(draft['updatedAt']);
            const draftFields = [
              'version',
              'id',
              'intentId',
              'policyId',
              'channel',
              'recipient',
              'subject',
              'body',
              'senderIdentity',
              'createdAt',
            ];
            meetingRequire(
              draft['draftSha256'] ==
                  await meetingSha({
                    for (final field in draftFields) field: draft[field],
                    if (draft['googleConnectionId'] != null)
                      'googleConnectionId': draft['googleConnectionId'],
                  }),
            );
          }
          if (value['workItem'] != null) {
            meetingRequire(
              meetingMap(value['workItem'])['id'] == resolution['workItemId'],
            );
          }
        }
        if (value['meeting'] != null) {
          meeting = Meeting.fromJson(meetingMap(value['meeting']));
          await verifyMeetingRevision(meeting);
          meetingRequire(
            meeting.id == submitted.id &&
                meeting.tenantId == owner.tenantId &&
                meeting.workspaceId == context.workspaceId &&
                meeting.revisionId == resolution['meetingRevisionId'],
          );
        }
      }
    }
    return MeetingAcceptedReceipt(
      submitted,
      freezeMeeting(value) as Json,
      meeting: meeting,
      commitment: commitment,
      draft: draft == null ? null : freezeMeeting(draft) as Json,
    );
  }
}

Json meetingEditableDefinition(Meeting meeting) {
  final raw = meeting.raw;
  meetingRequire(
    raw != null,
    'A complete current Meeting revision is required for editing.',
  );
  const fields = [
    'title',
    'summary',
    'status',
    'scheduledStartAt',
    'scheduledEndAt',
    'actualStartAt',
    'actualEndAt',
    'timezone',
    'location',
    'projectId',
    'declaredAccessClass',
    'participants',
    'entityLinks',
    'decisions',
    'commitments',
    'followUps',
  ];
  return {
    for (final field in fields) field: raw![field],
    'sourceLinks': [
      for (final source in meeting.evidence)
        {
          'linkId': source.id,
          'kind': source.kind,
          'sourceId': source.sourceId,
          if (source.kind != 'capture_recording' &&
              source.kind != 'capture_asset')
            'sourceRevisionId': source.revisionId,
          'mediaRole': source.role,
          'label': source.label,
        },
    ],
  };
}
