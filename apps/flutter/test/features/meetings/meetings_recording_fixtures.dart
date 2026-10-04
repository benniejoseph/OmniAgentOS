import 'dart:async';

import 'package:asael/features/meetings/meetings.dart';
import 'package:asael/features/meetings/meetings_access.dart';
import 'package:asael/features/meetings/meetings_api_repository.dart';
import 'package:asael/features/meetings/meetings_draft_store.dart';
import 'package:asael/features/meetings/meetings_mutations.dart';
import 'package:asael/features/meetings/meetings_recording_contracts.dart';
import 'package:asael/features/meetings/meetings_validation.dart';
import 'package:dio/dio.dart';

import 'meetings_test_support.dart';

const recordingTime = '2026-10-05T12:00:00.000Z';
MeetingJson testRecordingScope() => recordingScope(
  meetingOwner,
  'workspace:native',
  meetingTestId,
  'recording-1',
);
Future<MeetingJson> recordingSeal(
  MeetingJson body,
  String operation, {
  MeetingRecordingSubmission? sent,
}) async {
  final mutation = sent != null;
  final scope = mutation
      ? {
          'version': 1,
          'tenantId': meetingOwner.tenantId,
          'initiatingActorId': meetingOwner.actorId,
          'executingPrincipalType': 'user',
          'executingPrincipalId': meetingOwner.actorId,
          'workspaceId': 'workspace:native',
          'projectId': null,
          'missionId': null,
          'delegationId': null,
          'correlationId': sent.key.length <= 256
              ? sent.key
              : await meetingSha(sent.key),
          'causationId': sent.recordingId,
          'contextGrantIds': <String>[],
          'capabilityGrantIds': <String>[],
          'purpose': 'api.meeting-recording.process',
        }
      : null;
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': operation,
    'action': mutation ? 'write.memory' : 'read',
    'resourceType': 'capture_recording',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? 'meeting-recording-processing-events.v1'
        : 'read_only:no_domain_mutation',
    'authoritySha256': await meetingSha({
      'boundaryVersion': 'p9.1-app-service-boundary:1',
      'tenantId': meetingOwner.tenantId,
      'actorId': meetingOwner.actorId,
      'role': meetingOwner.role,
      'executionScope': scope,
    }),
    'idempotencyKeySha256': mutation
        ? await meetingShaText('${meetingOwner.tenantId}\u0000${sent.key}')
        : null,
    'outcomeSha256': await meetingSha(body),
    'resourceCount': body.containsKey('review') || body['acceptance'] != null
        ? 1
        : 0,
    'occurredAt': recordingTime,
  };
  return {
    ...body,
    'serviceReceipt': {...receipt, 'receiptSha256': await meetingSha(receipt)},
  };
}

Future<MeetingJson> recordingReviewFixture() async {
  final pin = {
    'meetingRevision': 2,
    'meetingSha256': meetingDigest,
    'sourceLinkId': 'source-1',
    'sourceLinkSha256': 'b' * 64,
    'consentSha256': 'c' * 64,
    'recordingStateSha256': 'd' * 64,
    'sourceAudioManifestSha256': 'e' * 64,
    'transcriptCheckpointSha256': 'f' * 64,
    'mediaGeneration': 0,
    'mediaHeadSha256': null,
    'policySha256': await meetingSha({
      'version': 'meeting-recording-policy:1',
      'retention': 'retain',
      'nativeProviderAttempts': 1,
      'acceptanceRecovery': 'read_only',
      'uncertainEffect': 'hold',
      'source': 'exact_owned_linked_recording',
    }),
  };
  return recordingSeal({
    'contract': recordingReadContract,
    'scope': testRecordingScope(),
    'review': {
      'pin': {...pin, 'reviewSha256': await meetingSha(pin)},
      'recording': {
        'title': 'Recorded planning session',
        'status': 'recording',
        'language': 'en',
        'segmentCount': 2,
        'durationMs': 30000,
        'byteCount': 12000,
        'cachedTranscripts': 1,
      },
      'participants': [
        {
          'participantId': 'person-1',
          'displayName': 'Owner',
          'recordingConsent': 'granted',
          'consentCapturedAt': recordingTime,
        },
      ],
      'eligibility': {'processable': true, 'reasonCodes': <String>[]},
    },
  }, 'app.meetings.recordings.review');
}

Future<MeetingRecordingReview> recordingReview() async =>
    MeetingRecordingReview.parse(
      await recordingReviewFixture(),
      meetingOwner,
      testRecordingScope(),
    );
Future<MeetingRecordingSubmission> recordingSubmission({
  String key = 'recording-key',
}) async => MeetingRecordingSubmission.prepare(
  meetingOwner,
  await recordingReview(),
  languages: ['en'],
  mappings: [],
  key: key,
);
Future<MeetingJson> recordingResultFixture(
  MeetingRecordingSubmission sent, {
  bool mutation = true,
  bool absent = false,
  String phase = 'queued',
}) async {
  final proof = {
    'contract': 'asael-meeting-recording-acceptance:1',
    'id':
        'meeting-recording-acceptance:${await meetingSha({'scope': sent.scope, 'keySha256': sent.keySha256})}',
    'scope': sent.scope,
    'keySha256': sent.keySha256,
    'requestSha256': sent.requestSha256,
    'reviewSha256': (sent.body['review'] as Map)['reviewSha256'],
    'operationJobId': 'job:recording-1',
    'acceptedMediaGeneration': 1,
    'sourceAudioManifestSha256':
        (sent.body['review'] as Map)['sourceAudioManifestSha256'],
    'acceptedAt': recordingTime,
  };
  return recordingSeal(
    {
      'contract': recordingReadContract,
      'scope': sent.scope,
      'acceptance': absent
          ? null
          : {...proof, 'acceptanceSha256': await meetingSha(proof)},
      'processing': absent
          ? null
          : {
              'phase': phase,
              'completedSegments': phase == 'queued' ? 1 : 2,
              'totalSegments': 2,
              'media': phase == 'queued'
                  ? null
                  : {
                      'mediaRevisionId': '${sent.recordingId}:media:v1',
                      'outputSha256': 'a' * 64,
                    },
              'knowledge': phase == 'queued'
                  ? null
                  : {
                      'state': phase == 'completed'
                          ? 'committed'
                          : 'unconfirmed',
                      'jobId': 'job:knowledge-1',
                      'documentId': phase == 'completed'
                          ? 'document:recording-1'
                          : null,
                    },
              'reasonCode': phase == 'reconciliation_required'
                  ? 'projection_unconfirmed'
                  : null,
              'updatedAt': recordingTime,
              'automaticRetryAllowed': false,
            },
      if (mutation) 'replayed': false,
    },
    mutation
        ? 'app.meetings.recordings.process'
        : 'app.meetings.recordings.processing.show',
    sent: mutation ? sent : null,
  );
}

class RecordingRepository extends FakeMeetingsRepository
    implements RecordingMeetingsRepository {
  RecordingRepository() {
    access.operations.addAll({
      'meetings.recordings.review',
      'meetings.recordings.process',
      'meetings.recordings.processing.get',
    });
  }
  int posts = 0, exactReads = 0;
  MeetingRecordingSubmission? last;
  Completer<Json>? heldReview;
  Future<Json> Function(MeetingRecordingSubmission)? onProcess, onExact;
  @override
  Future<Json> recordingReview(Json scope, CancelToken cancel) =>
      heldReview?.future ?? recordingReviewFixture();
  @override
  Future<Json> recordingProcessing(
    MeetingRecordingSubmission submitted,
    CancelToken cancel,
  ) async {
    exactReads++;
    return onExact == null
        ? await recordingResultFixture(submitted, mutation: false)
        : await onExact!(submitted);
  }

  @override
  Future<Json> recordingProcess(
    MeetingRecordingSubmission submitted, {
    required bool Function() isCurrent,
  }) async {
    if (!isCurrent()) {
      throw StateError('Current authority lost.');
    }
    posts++;
    last = submitted;
    return onProcess == null
        ? await recordingResultFixture(submitted)
        : await onProcess!(submitted);
  }
}

class RecordingStore extends MemoryMeetingDraftStore {
  bool failWrites = false;
  @override
  Future<void> write(
    MeetingsOwner owner,
    String route,
    MeetingJson payload, {
    required bool Function() isCurrent,
  }) async {
    if (failWrites) {
      throw StateError('Acknowledgement unavailable');
    }
    await super.write(owner, route, payload, isCurrent: isCurrent);
  }
}
