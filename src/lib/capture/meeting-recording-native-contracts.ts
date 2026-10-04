import { z } from "zod";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

export const MEETING_RECORDING_READ_CONTRACT = "asael-meeting-recording-read:1" as const;
export const MEETING_RECORDING_POLICY_SHA256 = canonicalJsonSha256({ version: "meeting-recording-policy:1", retention: "retain",
  nativeProviderAttempts: 1, acceptanceRecovery: "read_only", uncertainEffect: "hold", source: "exact_owned_linked_recording" });
export const meetingRecordingIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
export const meetingRecordingMeetingIdSchema = z.string().regex(/^meeting:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const meetingRecordingWorkspaceIdSchema = z.string().min(11).max(240).regex(/^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
export const meetingRecordingShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sha = meetingRecordingShaSchema, at = z.string().datetime({ offset: true }).refine((value) => new Date(value).toISOString() === value);
const count = z.number().int().nonnegative().max(2_147_483_647);
const normalized = (max: number) => z.string().min(1).max(max).refine((value) => value === value.trim());
export const meetingRecordingScopeSchema = z.object({ tenantId: normalized(120), ownerActorId: normalized(320),
  canonicalActorId: z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
  workspaceId: meetingRecordingWorkspaceIdSchema, meetingId: meetingRecordingMeetingIdSchema, recordingId: meetingRecordingIdSchema }).strict();
const pinBody = z.object({ meetingRevision: count.min(1), meetingSha256: sha, sourceLinkId: meetingRecordingIdSchema,
  sourceLinkSha256: sha, consentSha256: sha, recordingStateSha256: sha, sourceAudioManifestSha256: sha,
  transcriptCheckpointSha256: sha, mediaGeneration: count, mediaHeadSha256: sha.nullable(), policySha256: z.literal(MEETING_RECORDING_POLICY_SHA256) }).strict();
export const meetingRecordingReviewPinSchema = pinBody.extend({ reviewSha256: sha }).strict().superRefine((value, context) => {
  const { reviewSha256, ...body } = value;
  if (reviewSha256 !== canonicalJsonSha256(body) || (value.mediaGeneration === 0) !== (value.mediaHeadSha256 === null)) context.addIssue({ code: "custom", message: "Review pin does not bind its exact source and policy." });
});
export const meetingRecordingReasonSchema = z.enum(["recording_empty", "audio_deleted", "consent_required", "source_changed", "legacy_processing_pending",
  "legacy_effect_unconfirmed", "already_accepted", "authority_changed", "source_manifest_changed", "provider_effect_unconfirmed", "projection_unconfirmed", "job_unavailable"]);
export const meetingRecordingReviewSchema = z.object({ pin: meetingRecordingReviewPinSchema,
  recording: z.object({ title: z.string().max(240), status: z.enum(["recording", "processing", "ready", "failed"]), language: normalized(35),
    segmentCount: count.max(1_440), durationMs: count.max(86_400_000), byteCount: count.max(1_073_741_824), cachedTranscripts: count.max(1_440) }).strict(),
  participants: z.array(z.object({ participantId: meetingRecordingIdSchema, displayName: normalized(160),
    recordingConsent: z.enum(["granted", "declined", "pending", "not_required", "unknown"]), consentCapturedAt: at.nullable() }).strict()).max(200),
  eligibility: z.object({ processable: z.boolean(), reasonCodes: z.array(meetingRecordingReasonSchema).max(12) }).strict(),
}).strict().refine((value) => value.eligibility.processable === (value.eligibility.reasonCodes.length === 0), "Eligibility must reflect all current blockers.");
const language = z.string().min(2).max(35).regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/);
export const meetingRecordingProcessRequestSchema = z.object({ contract: z.literal("asael-meeting-recording-process:1"),
  workspaceId: meetingRecordingWorkspaceIdSchema, meetingId: meetingRecordingMeetingIdSchema, review: meetingRecordingReviewPinSchema,
  languageHints: z.array(language).min(1).max(12), speakerMappings: z.array(z.object({ speakerLabel: normalized(80),
    participantId: meetingRecordingIdSchema, displayName: normalized(160), confirmation: z.literal("user_confirmed") }).strict()).max(40),
  rawAudioRetention: z.object({ mode: z.literal("retain") }).strict(),
}).strict().superRefine((value, context) => {
  const labels = value.speakerMappings.map((item) => item.speakerLabel.toLocaleLowerCase("en-US"));
  if (new Set(labels).size !== labels.length || new Set(value.speakerMappings.map((item) => item.participantId)).size !== value.speakerMappings.length ||
    new Set(value.languageHints).size !== value.languageHints.length) context.addIssue({ code: "custom", message: "Languages and confirmed speaker mappings must be unique." });
});
export const meetingRecordingIntentSchema = z.object({ contract: z.literal("asael-meeting-recording-intent:1"), scope: meetingRecordingScopeSchema,
  keySha256: sha, request: meetingRecordingProcessRequestSchema }).strict().refine((value) => value.scope.workspaceId === value.request.workspaceId && value.scope.meetingId === value.request.meetingId,
  "Processing intent must bind its exact Meeting workspace.");
const acceptanceBody = z.object({ contract: z.literal("asael-meeting-recording-acceptance:1"),
  id: z.string().regex(/^meeting-recording-acceptance:[a-f0-9]{64}$/), scope: meetingRecordingScopeSchema,
  keySha256: sha, requestSha256: sha, reviewSha256: sha, operationJobId: meetingRecordingIdSchema, acceptedMediaGeneration: count.min(1),
  sourceAudioManifestSha256: sha, acceptedAt: at }).strict();
export const meetingRecordingAcceptanceSchema = acceptanceBody.extend({ acceptanceSha256: sha }).strict().superRefine((value, context) => {
  const { acceptanceSha256, ...body } = value;
  if (acceptanceSha256 !== canonicalJsonSha256(body) || value.id !== meetingRecordingAcceptanceId(value.scope, value.keySha256)) context.addIssue({ code: "custom", message: "Acceptance identity or digest is inconsistent." });
});
export const meetingRecordingProcessingSchema = z.object({ phase: z.enum(["queued", "transcribing", "extracting", "indexing", "completed", "reconciliation_required", "blocked"]),
  completedSegments: count.max(1_440), totalSegments: count.max(1_440),
  media: z.object({ mediaRevisionId: z.string().min(1).max(260), outputSha256: sha }).strict().nullable(),
  knowledge: z.object({ state: z.enum(["queued", "started", "committed", "unconfirmed", "blocked"]), jobId: meetingRecordingIdSchema,
    documentId: meetingRecordingIdSchema.nullable() }).strict().nullable(),
  reasonCode: meetingRecordingReasonSchema.nullable(), updatedAt: at, automaticRetryAllowed: z.literal(false),
}).strict().refine((value) => value.completedSegments <= value.totalSegments &&
  (value.phase !== "completed" || value.media !== null && value.knowledge?.state === "committed"), "Processing observation is inconsistent.");
export type MeetingRecordingScope = z.infer<typeof meetingRecordingScopeSchema>;
export type MeetingRecordingReview = z.infer<typeof meetingRecordingReviewSchema>;
export type MeetingRecordingRequest = z.infer<typeof meetingRecordingProcessRequestSchema>;
export type MeetingRecordingIntent = z.infer<typeof meetingRecordingIntentSchema>;
export type MeetingRecordingAcceptance = z.infer<typeof meetingRecordingAcceptanceSchema>;
export type MeetingRecordingProcessing = z.infer<typeof meetingRecordingProcessingSchema>;
export function meetingRecordingAcceptanceId(scope: MeetingRecordingScope, keySha256: string) {
  return `meeting-recording-acceptance:${canonicalJsonSha256({ scope, keySha256 })}`;
}
export function buildMeetingRecordingIntent(input: { scope: MeetingRecordingScope; idempotencyKey: string; request: MeetingRecordingRequest }) {
  const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/).parse(input.idempotencyKey);
  return meetingRecordingIntentSchema.parse({ contract: "asael-meeting-recording-intent:1", scope: input.scope,
    keySha256: idempotencyKeySha256({ tenantId: input.scope.tenantId, idempotencyKey: key }), request: input.request });
}
export function sealMeetingRecordingReviewPin(input: z.input<typeof pinBody>) { const value = pinBody.parse(input); return meetingRecordingReviewPinSchema.parse({ ...value, reviewSha256: canonicalJsonSha256(value) }); }
export function sealMeetingRecordingAcceptance(input: z.input<typeof acceptanceBody>) { const value = acceptanceBody.parse(input); return meetingRecordingAcceptanceSchema.parse({ ...value, acceptanceSha256: canonicalJsonSha256(value) }); }
export class MeetingRecordingNativeError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); this.name = "MeetingRecordingNativeError"; }
}
