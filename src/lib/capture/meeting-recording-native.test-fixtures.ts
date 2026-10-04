import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { MEETING_RECORDING_POLICY_SHA256, buildMeetingRecordingIntent, meetingRecordingAcceptanceId,
  sealMeetingRecordingAcceptance, sealMeetingRecordingReviewPin, type MeetingRecordingRequest, type MeetingRecordingScope } from "@/lib/capture/meeting-recording-native-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const recordingScope: MeetingRecordingScope = { tenantId: "recording-test", ownerActorId: "recording-owner@example.test",
  canonicalActorId: "actor:11111111-1111-4111-8111-111111111111", workspaceId: "workspace:recording-test",
  meetingId: "meeting:22222222-2222-4222-8222-222222222222", recordingId: "recording-test" };
export const recordingContext = { tenantId: recordingScope.tenantId, actorId: recordingScope.ownerActorId, role: "operator" as const,
  source: "mobile" as const, auth: { userId: recordingScope.canonicalActorId.slice(6), email: recordingScope.ownerActorId, sessionId: "session-recording", tenantName: "Recording fixture" } };
export const recordingKey = "recording-process-1";
export const recordingPin = sealMeetingRecordingReviewPin({ meetingRevision: 1, meetingSha256: "a".repeat(64), sourceLinkId: "recording-link",
  sourceLinkSha256: "b".repeat(64), consentSha256: "c".repeat(64), recordingStateSha256: "d".repeat(64),
  sourceAudioManifestSha256: "e".repeat(64), transcriptCheckpointSha256: "f".repeat(64), mediaGeneration: 0, mediaHeadSha256: null, policySha256: MEETING_RECORDING_POLICY_SHA256 });
export const recordingRequest: MeetingRecordingRequest = { contract: "asael-meeting-recording-process:1", workspaceId: recordingScope.workspaceId,
  meetingId: recordingScope.meetingId, review: recordingPin, languageHints: ["en-US"], speakerMappings: [], rawAudioRetention: { mode: "retain" } };
export function recordingCaller(mutation = true) {
  return createAppServiceCaller({ context: recordingContext, ...(mutation ? { idempotencyKey: recordingKey, executionScope: createExecutionScope({
    tenantId: recordingScope.tenantId, initiatingActorId: recordingScope.ownerActorId, executingPrincipalType: "user", executingPrincipalId: recordingScope.ownerActorId,
    workspaceId: recordingScope.workspaceId, correlationId: "recording-correlation", causationId: recordingScope.recordingId, purpose: "api.meeting-recording.process" }) } : {}) });
}
export function recordingFixture() {
  const intent = buildMeetingRecordingIntent({ scope: recordingScope, request: recordingRequest, idempotencyKey: recordingKey });
  const acceptance = sealMeetingRecordingAcceptance({ contract: "asael-meeting-recording-acceptance:1", id: meetingRecordingAcceptanceId(recordingScope, intent.keySha256),
    scope: recordingScope, keySha256: intent.keySha256, requestSha256: canonicalJsonSha256(intent), reviewSha256: recordingPin.reviewSha256,
    operationJobId: "recording-process-job", acceptedMediaGeneration: 1, sourceAudioManifestSha256: recordingPin.sourceAudioManifestSha256, acceptedAt: "2026-10-05T10:00:00.000Z" });
  const processing = { phase: "queued" as const, completedSegments: 0, totalSegments: 1, media: null, knowledge: null, reasonCode: null,
    updatedAt: acceptance.acceptedAt, automaticRetryAllowed: false as const };
  return { intent, acceptance, processing };
}
