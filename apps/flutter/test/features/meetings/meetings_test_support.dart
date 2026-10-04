import 'package:asael/features/meetings/meetings.dart';
import 'package:asael/features/meetings/meetings_access.dart';
import 'package:asael/features/meetings/meetings_api_repository.dart';
import 'package:asael/features/meetings/meetings_commitments.dart';
import 'package:asael/features/meetings/meetings_mutations.dart';
import 'package:asael/features/meetings/meetings_snapshots.dart';
import 'package:dio/dio.dart';

const meetingTestId = 'meeting:11111111-1111-4111-8111-111111111111';
const meetingOtherId = 'meeting:22222222-2222-4222-8222-222222222222';
const meetingUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const meetingOwner = MeetingsOwner(
  userId: meetingUserId,
  tenantId: 'tenant-native',
  actorId: 'owner@example.test',
  role: 'operator',
  apiScope: 'https://api.example.test',
);
final meetingDigest = 'a' * 64;
Json meetingContextJson() => {
  'scope': 'workspace',
  'workspaceId': 'workspace:native',
  'accessLevel': 'manager',
  'canWrite': true,
  'authoritySha256': meetingDigest,
};
Json meetingJson({
  String id = meetingTestId,
  int revision = 2,
  String title = 'Launch review',
  bool source = false,
}) => {
  'schemaVersion': 1,
  'tenantId': meetingOwner.tenantId,
  'workspaceId': 'workspace:native',
  'meetingId': id,
  'meetingRevisionId': '$id:v$revision',
  'previousMeetingRevisionId': revision == 1 ? null : '$id:v${revision - 1}',
  'revision': revision,
  'ownerActorId': 'actor:$meetingUserId',
  'revisedByActorId': 'actor:$meetingUserId',
  'revisedAt': '2026-10-04T10:00:00.000Z',
  'meetingSha256': meetingDigest,
  'consentSnapshotSha256': meetingDigest,
  'title': title,
  'summary': 'Inspect exact source evidence.',
  'status': 'scheduled',
  'scheduledStartAt': '2026-10-05T10:00:00.000Z',
  'scheduledEndAt': '2026-10-05T11:00:00.000Z',
  'actualStartAt': null,
  'actualEndAt': null,
  'timezone': 'UTC',
  'location': 'Studio',
  'projectId': null,
  'declaredAccessClass': 'owner_private',
  'effectiveAccessClass': 'owner_private',
  'participants': [
    {
      'participantId': 'person-1',
      'displayName': 'Owner',
      'email': 'owner@example.test',
      'entityId': null,
      'role': 'organizer',
      'response': 'accepted',
      'attendeeConsent': 'unknown',
      'recordingConsent': source ? 'granted' : 'unknown',
      'consentCapturedAt': source ? '2026-10-04T10:00:00.000Z' : null,
      'source': 'manual',
    },
  ],
  'sourceLinks': [
    if (source)
      {
        'linkId': 'source-1',
        'kind': 'capture_recording',
        'sourceId': 'recording-1',
        'sourceRevisionId': 'recording-1:revision:1',
        'sourceRevisionSha256': meetingDigest,
        'sourceAuthoritySha256': meetingDigest,
        'accessClass': 'owner_private',
        'mediaRole': 'recording',
        'label': 'Recorded evidence',
      },
  ],
  'entityLinks': [],
  'decisions': [
    {
      'decisionId': 'decision-1',
      'summary': 'Review before release',
      'ownerParticipantId': 'person-1',
      'sourceLinkId': source ? 'source-1' : null,
    },
  ],
  'commitments': [],
  'followUps': [],
};
Json meetingDetailJson({
  String id = meetingTestId,
  int revision = 2,
  bool pending = false,
}) => {
  'context': meetingContextJson(),
  'meeting': meetingJson(id: id, revision: revision, source: pending),
  'linkedSources': [
    if (pending)
      {
        'linkId': 'source-1',
        'kind': 'capture_recording',
        'sourceId': 'recording-1',
        'mediaRole': 'recording',
        'label': 'Recorded evidence',
        'revisionState': 'exact',
        'status': 'completed',
        'mediaType': 'audio/webm',
        'durationMs': 1000,
        'byteCount': 512,
        'updatedAt': '2026-10-04T10:00:00.000Z',
        'transcript': '',
        'transcriptTruncated': false,
        'segments': [],
        'media': {
          'processingStatus': 'waiting',
          'operationJobId': 'job-1',
          'rawAudioDeletedAt': null,
          'updatedAt': '2026-10-04T10:00:00.000Z',
          'output': null,
        },
      },
  ],
};
Json meetingCommitmentsJson({String id = meetingTestId, int revision = 2}) => {
  'context': meetingContextJson(),
  'meeting': {
    'meetingId': id,
    'meetingRevisionId': '$id:v$revision',
    'revision': revision,
    'title': 'Launch review',
    'projectId': null,
    'participants': meetingJson()['participants'],
  },
  'commitments': [],
  'eligiblePolicies': [],
};
MeetingDetailSnapshot meetingDetail({
  String id = meetingTestId,
  int revision = 2,
  bool pending = false,
}) => MeetingDetailSnapshot.parse(
  meetingDetailJson(id: id, revision: revision, pending: pending),
  id: id,
  tenantId: meetingOwner.tenantId,
);

class FakeMeetingsRepository implements MutatingMeetingsRepository {
  @override
  final access = MeetingsAccess(
    owner: meetingOwner,
    ready: true,
    commitmentsAvailable: true,
    operations: meetingWriteOperations.values.toSet(),
  );
  int listReads = 0, detailReads = 0, commitmentReads = 0, writes = 0;
  final List<CancelToken> tokens = [];
  final List<MeetingSubmission> submissions = [];
  Future<MeetingsSnapshot> Function()? listReader;
  Future<MeetingDetailSnapshot> Function(String)? detailReader;
  Future<MeetingCommitmentsSnapshot> Function(String)? commitmentReader;
  Future<Json> Function(MeetingSubmission)? writer;
  @override
  bool authorityCurrent() => access.readable;
  @override
  Future<MeetingsSnapshot> listSnapshot(
    CancelToken cancel, {
    String? workspaceId,
  }) async {
    listReads++;
    tokens.add(cancel);
    return listReader == null
        ? MeetingsSnapshot.parse({
            'context': meetingContextJson(),
            'meetings': [meetingJson()],
          }, tenantId: meetingOwner.tenantId)
        : listReader!();
  }

  @override
  Future<MeetingDetailSnapshot> detailSnapshot(
    String id,
    CancelToken cancel, {
    String? workspaceId,
  }) async {
    detailReads++;
    tokens.add(cancel);
    return detailReader == null ? meetingDetail(id: id) : detailReader!(id);
  }

  @override
  Future<MeetingCommitmentsSnapshot> commitmentsSnapshot(
    String id,
    CancelToken cancel, {
    String? workspaceId,
  }) async {
    commitmentReads++;
    tokens.add(cancel);
    return commitmentReader == null
        ? MeetingCommitmentsSnapshot.parse(
            meetingCommitmentsJson(id: id),
            id: id,
            tenantId: meetingOwner.tenantId,
          )
        : commitmentReader!(id);
  }

  @override
  Future<List<Meeting>> list() async =>
      (await listSnapshot(CancelToken())).meetings;
  @override
  Future<Meeting> detail(String id) async =>
      (await detailSnapshot(id, CancelToken())).meeting;
  @override
  Future<Json> mutate(MeetingSubmission submitted) async {
    writes++;
    submissions.add(submitted);
    return writer!(submitted);
  }
}

Future<Json> createMeetingReceipt(MeetingSubmission submitted) async {
  final saved =
      meetingJson(
        revision: submitted.action == 'update'
            ? (submitted.body['expectedRevision'] as int) + 1
            : 1,
      )..addAll(
        {...submitted.body}
          ..remove('workspaceId')
          ..remove('expectedRevision'),
      );
  final data = {
    'context': meetingContextJson(),
    'meeting': await sealMeeting(saved),
    'linkedSources': <Object?>[],
  };
  final service = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': 'app.${submitted.operation}',
    'action': 'manage.workflow',
    'resourceType': 'meeting',
    'accessMode': 'mutation',
    'eventContract': 'meeting-events.v1',
    'authoritySha256': meetingDigest,
    'idempotencyKeySha256': await meetingShaText(
      '${meetingOwner.tenantId}\u0000${submitted.key}',
    ),
    'outcomeSha256': await meetingSha(data),
    'resourceCount': 1,
    'occurredAt': '2026-10-04T10:00:00.000Z',
  };
  return {
    ...data,
    'serviceReceipt': {...service, 'receiptSha256': await meetingSha(service)},
  };
}

MeetingSubmission createSubmission({String? key}) => MeetingSubmission.freeze(
  action: 'create',
  owner: meetingOwner,
  key: key,
  body: {
    'workspaceId': 'workspace:native',
    ...meetingEditableDefinition(Meeting.fromJson(meetingJson())),
  },
);

Future<Json> sealMeeting(Json value) async {
  final row = {...value};
  row['consentSnapshotSha256'] = await meetingSha([
    for (final person in row['participants'] as List)
      {
        'participantId': person['participantId'],
        'attendeeConsent': person['attendeeConsent'],
        'recordingConsent': person['recordingConsent'],
        'consentCapturedAt': person['consentCapturedAt'],
      },
  ]);
  row.remove('meetingSha256');
  row['meetingSha256'] = await meetingSha(row);
  return row;
}

Future<Json> sealMeetingRead(Json body, String operation) async {
  final data = {...body};
  if (data['meeting'] is Map && data['meeting']['schemaVersion'] == 1) {
    data['meeting'] = await sealMeeting(
      Map<String, dynamic>.from(data['meeting'] as Map),
    );
  }
  if (data['meetings'] is List) {
    data['meetings'] = [
      for (final row in data['meetings'] as List)
        await sealMeeting(Map<String, dynamic>.from(row as Map)),
    ];
  }
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': operation,
    'action': 'read',
    'resourceType': operation == 'app.meetings.commitments.list'
        ? 'meeting_commitment'
        : 'meeting',
    'accessMode': 'read',
    'eventContract': 'read_only:no_domain_mutation',
    'authoritySha256': meetingDigest,
    'idempotencyKeySha256': null,
    'outcomeSha256': await meetingSha(data),
    'resourceCount': 1,
    'occurredAt': '2026-10-04T10:00:00.000Z',
  };
  return {
    ...data,
    'serviceReceipt': {...receipt, 'receiptSha256': await meetingSha(receipt)},
  };
}
