import { z } from "zod";

import { appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  captureMediaOutputSchema,
  captureRawAudioRetentionSchema,
  captureSpeakerMappingSchema,
} from "@/lib/capture/media-contracts";
import { messageDraftSchema, personContactPolicySchema } from "@/lib/communications/contracts";
import {
  meetingCommitmentProposalSchema,
  meetingCommitmentResolutionSchema,
} from "@/lib/meetings/commitment-contracts";
import {
  meetingDraftInputSchema,
  meetingParticipantSchema,
  meetingRevisionSchema,
  meetingSourceLinkSchema,
  type MeetingRevision,
} from "@/lib/meetings/contracts";
import { meetingResolutionReconciliationSchema } from "@/lib/meetings/commitment-resolution-intent";
import { canonicalWorkItemSurfaceSchema } from "@/lib/workspaces/surface";

// v33 publishes only the bounded map below. Importing these shapes grants no
// authority; route enrollment remains separate. Domain refinements verify immutable
// digests in-process; generated JSON Schema cannot replace runtime authorization.
const id = z.string().trim().min(1).max(240);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const meetingId = meetingRevisionSchema.shape.meetingId;
const workspaceId = meetingRevisionSchema.shape.workspaceId;
const requestWorkspace = { workspaceId: id.optional() };
const processingStatus = z.enum(["queued", "processing", "waiting", "ready", "failed"]);
const issue = (context: z.RefinementCtx, message: string, path: PropertyKey[] = []) =>
  context.addIssue({ code: "custom", message, path });
function unique(values: readonly string[], context: z.RefinementCtx, path: PropertyKey[]) {
  if (new Set(values).size !== values.length) issue(context, "Duplicate exact identities are invalid.", path);
}
function serviceReceipt(operation: Parameters<typeof getAppServiceOperationContract>[0], mode: "read" | "mutation") {
  const expected = getAppServiceOperationContract(operation);
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== operation || value.accessMode !== mode ||
      value.action !== expected.action || value.resourceType !== expected.resourceType ||
      value.eventContract !== expected.eventContract ||
      (value.idempotencyKeySha256 !== null) !== (mode === "mutation")) {
      issue(context, "The service receipt belongs to a different operation.");
    }
  });
}

function checkOutcome(value: { serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, context: z.RefinementCtx) {
  const { serviceReceipt: receipt, ...data } = value;
  if (receipt.outcomeSha256 !== canonicalJsonSha256(data)) issue(context, "The service receipt does not describe this exact response body.", ["serviceReceipt", "outcomeSha256"]);
}

// These are HTTP bodies: route-owned meetingId is intentionally absent. The
// services add that path identity before parsing their strict domain input.
export const nativeMeetingListQuerySchema = z.object({
  ...requestWorkspace,
  status: meetingRevisionSchema.shape.status.optional(),
  limit: z.number().int().min(1).max(200).default(100),
}).strict();
export const nativeMeetingReadQuerySchema = z.object(requestWorkspace).strict();
export const nativeMeetingCreateRequestSchema = meetingDraftInputSchema.extend(requestWorkspace).strict();
export const nativeMeetingUpdateRequestSchema = meetingDraftInputSchema.extend({
  ...requestWorkspace,
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
export const nativeMeetingCommitmentProposeRequestSchema = z.object({
  ...requestWorkspace,
  mediaRevisionId: z.string().trim().min(1).max(260),
  actionItemId: z.string().regex(/^media-action:[a-f0-9]{64}$/),
}).strict();
const communicationRequest = z.object({
  connectionId: z.string().uuid().optional(),
  policyId: z.string().regex(/^contact_policy:[0-9a-f-]{36}$/),
  recipientParticipantId: id,
  subject: z.string().trim().min(1).max(998).refine((value) => !/[\r\n]/.test(value)),
  body: z.string().trim().min(1).max(50_000),
}).strict();
const resolutionRequestBase = {
  ...requestWorkspace,
  proposalId: z.string().regex(/^meeting-commitment-proposal:[a-f0-9]{64}$/),
  expectedProposalSha256: sha,
};
export const nativeMeetingCommitmentResolveRequestSchema = z.discriminatedUnion("decision", [
  z.object({ ...resolutionRequestBase, decision: z.literal("dismissed") }).strict(),
  z.object({
    ...resolutionRequestBase, decision: z.literal("confirmed"),
    ownerParticipantId: id.optional(), dueAt: timestamp.nullable().optional(),
    communication: communicationRequest.nullable().default(null),
  }).strict(),
]);

export const nativeMeetingContextSchema = z.object({
  scope: z.literal("workspace"), workspaceId,
  accessLevel: z.enum(["reader", "contributor", "manager"]),
  canWrite: z.boolean(), authoritySha256: sha,
}).strict().superRefine((value, context) => {
  if (value.canWrite !== (value.accessLevel !== "reader")) issue(context, "Workspace access level and write disclosure disagree.");
});
export const nativeMeetingProcessedMediaSchema = z.object({
  processingStatus, operationJobId: id,
  rawAudioDeletedAt: timestamp.nullable(), updatedAt: timestamp,
  output: captureMediaOutputSchema.nullable(),
}).strict();
export const nativeMeetingLinkedSourceSchema = z.object({
  linkId: id, kind: meetingSourceLinkSchema.shape.kind,
  sourceId: id, mediaRole: meetingSourceLinkSchema.shape.mediaRole,
  label: z.string().trim().min(1).max(240),
  revisionState: z.enum(["exact", "changed", "unavailable"]),
  status: z.string().min(1).max(160).nullable(),
  mediaType: z.string().min(1).max(240).nullable(),
  durationMs: z.number().int().min(0).max(86_400_000).nullable(),
  byteCount: count.nullable(), updatedAt: timestamp.nullable(),
  transcript: z.string().max(500_000).nullable(), transcriptTruncated: z.boolean(),
  media: nativeMeetingProcessedMediaSchema.nullable(),
  segments: z.array(z.object({
    segmentIndex: z.number().int().min(0).max(1_439),
    mimeType: z.string().min(1).max(240),
    durationMs: z.number().int().min(0).max(600_000),
  }).strict()).max(1_440),
}).strict().superRefine((value, context) => {
  unique(value.segments.map((segment) => String(segment.segmentIndex)), context, ["segments"]);
  if (value.revisionState !== "exact" && (value.transcript !== null || value.transcriptTruncated || value.segments.length)) {
    issue(context, "Changed or unavailable sources cannot expose an exact transcript or segments.");
  }
  if (value.transcriptTruncated && value.transcript === null) issue(context, "Truncation requires returned transcript text.");
  if (value.kind !== "capture_recording" && (value.media !== null || value.segments.length || value.transcript !== null)) {
    issue(context, "Only the recording lane currently returns media and transcript content.");
  }
  if (value.revisionState === "unavailable" && [value.status, value.mediaType, value.durationMs, value.byteCount, value.updatedAt, value.media].some((field) => field !== null)) {
    issue(context, "An unavailable source cannot claim returned private metadata.");
  }
  if (value.media?.output && value.media.output.recordingId !== value.sourceId) {
    issue(context, "Media output does not belong to this exact recording.", ["media", "output", "recordingId"]);
  }
});

function checkMeetingWorkspace(meeting: MeetingRevision, currentWorkspace: string, context: z.RefinementCtx) {
  if (meeting.workspaceId !== currentWorkspace) issue(context, "Meeting workspace differs from the current response context.");
}
function checkLinkedSources(value: { meeting: MeetingRevision; linkedSources: z.infer<typeof nativeMeetingLinkedSourceSchema>[] }, context: z.RefinementCtx) {
  unique(value.linkedSources.map((source) => source.linkId), context, ["linkedSources"]);
  if (value.linkedSources.length !== value.meeting.sourceLinks.length) issue(context, "Every declared source requires its exact availability projection.");
  for (const [index, source] of value.linkedSources.entries()) {
    const link = value.meeting.sourceLinks.find((candidate) => candidate.linkId === source.linkId);
    if (!link || ["kind", "sourceId", "mediaRole", "label"].some((key) => source[key as keyof typeof source] !== link[key as keyof typeof link])) {
      issue(context, "Linked source identity differs from the immutable meeting revision.", ["linkedSources", index]);
    }
    const output = source.media?.output;
    if (output && (output.tenantId !== value.meeting.tenantId || output.meetingId !== value.meeting.meetingId)) {
      issue(context, "Media output belongs to another meeting or tenant.", ["linkedSources", index, "media", "output"]);
    }
  }
}
export const nativeMeetingListResponseSchema = z.object({
  context: nativeMeetingContextSchema,
  meetings: z.array(meetingRevisionSchema).max(200),
  serviceReceipt: serviceReceipt("app.meetings.list", "read"),
}).strict().superRefine((value, context) => {
  checkOutcome(value, context);
  unique(value.meetings.map((meeting) => meeting.meetingId), context, ["meetings"]);
  value.meetings.forEach((meeting) => checkMeetingWorkspace(meeting, value.context.workspaceId, context));
  if (value.serviceReceipt.resourceCount !== value.meetings.length) issue(context, "Meeting count differs from the returned bounded list.");
});
function detailResponse(operation: Parameters<typeof getAppServiceOperationContract>[0], mode: "read" | "mutation") {
  return z.object({
    context: nativeMeetingContextSchema, meeting: meetingRevisionSchema,
    linkedSources: z.array(nativeMeetingLinkedSourceSchema).max(100),
    serviceReceipt: serviceReceipt(operation, mode),
  }).strict().superRefine((value, context) => {
    checkOutcome(value, context);
    checkMeetingWorkspace(value.meeting, value.context.workspaceId, context);
    checkLinkedSources(value, context);
  });
}
export const nativeMeetingReadResponseSchema = detailResponse("app.meetings.show", "read");
export const nativeMeetingCreateResponseSchema = detailResponse("app.meetings.create", "mutation");
export const nativeMeetingUpdateResponseSchema = detailResponse("app.meetings.update", "mutation");

export const nativeMeetingCommitmentViewSchema = z.object({
  proposal: meetingCommitmentProposalSchema,
  resolution: meetingCommitmentResolutionSchema.nullable(),
  reconciliation: meetingResolutionReconciliationSchema.optional(),
}).strict().superRefine((value, context) => {
  const resolution = value.resolution;
  if (value.reconciliation && ((value.reconciliation.state === "resolved") !== (resolution !== null) ||
    resolution && value.reconciliation.decision !== resolution.decision)) issue(context, "Reconciliation and accepted resolution disagree.");
  if (resolution && (resolution.proposalId !== value.proposal.proposalId || resolution.proposalSha256 !== value.proposal.proposalSha256)) {
    issue(context, "The resolution belongs to another immutable proposal.");
  }
  if (resolution?.meetingRevisionId && !resolution.meetingRevisionId.startsWith(`${value.proposal.meetingId}:v`)) {
    issue(context, "The resolution belongs to another meeting revision.");
  }
});
export const nativeMeetingCommitmentSummarySchema = z.object({
  meetingId, meetingRevisionId: id, revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  title: z.string().trim().min(1).max(240), projectId: id.nullable(),
  participants: z.array(meetingParticipantSchema).max(250),
}).strict().superRefine((value, context) => {
  if (value.meetingRevisionId !== `${value.meetingId}:v${value.revision}`) issue(context, "Commitment summary revision identity is inconsistent.");
  unique(value.participants.map((participant) => participant.participantId), context, ["participants"]);
});
export const nativeMeetingCommitmentsResponseSchema = z.object({
  context: nativeMeetingContextSchema, meeting: nativeMeetingCommitmentSummarySchema,
  commitments: z.array(nativeMeetingCommitmentViewSchema).max(500),
  eligiblePolicies: z.array(personContactPolicySchema).max(200),
  serviceReceipt: serviceReceipt("app.meetings.commitments.list", "read"),
}).strict().superRefine((value, context) => {
  checkOutcome(value, context);
  unique(value.commitments.map((view) => view.proposal.proposalId), context, ["commitments"]);
  unique(value.eligiblePolicies.map((policy) => policy.id), context, ["eligiblePolicies"]);
  for (const view of value.commitments) {
    if (view.proposal.meetingId !== value.meeting.meetingId || view.proposal.workspaceId !== value.context.workspaceId) issue(context, "Proposal belongs to another meeting or workspace.");
    // Historical proposals deliberately retain the revision they were proposed
    // against. The list's current summary is the separate review freshness fence.
  }
  const emails = new Set(value.meeting.participants.flatMap((participant) => participant.email ? [participant.email.trim().toLocaleLowerCase("en-US")] : []));
  for (const policy of value.eligiblePolicies) {
    if (policy.channel !== "email" || policy.status !== "active" || policy.consent === "unknown" || !policy.allowedPurposes.includes("follow_up") || policy.allowedDisclosure === "public_only" || !emails.has(policy.address.trim().toLocaleLowerCase("en-US"))) issue(context, "Returned policy is not eligible for the current meeting participants.");
  }
  if (value.serviceReceipt.resourceCount !== value.commitments.length) issue(context, "Commitment count differs from returned proposals.");
});
export const nativeMeetingCommitmentProposeResponseSchema = z.object({
  context: nativeMeetingContextSchema, commitment: nativeMeetingCommitmentViewSchema,
  serviceReceipt: serviceReceipt("app.meetings.commitments.propose", "mutation"),
}).strict().superRefine((value, context) => {
  checkOutcome(value, context);
  if (value.commitment.proposal.workspaceId !== value.context.workspaceId) issue(context, "Proposal workspace differs from the current response context.");
});

// Current initial resolution returns the legacy task plus its canonical surface;
// it does not return a bare CanonicalWorkItemV1. Replay may omit these objects.
export const nativeMeetingCreatedWorkItemSchema = z.object({
  id, tenantId: id, projectId: id, title: z.string().min(1).max(240), detail: z.string().max(1_000),
  status: z.enum(["open", "doing", "done"]), priority: z.enum(["low", "medium", "high"]),
  agentId: z.enum(["atlas", "scout", "forge", "sentinel", "mnemosyne"]), position: count,
  origin: z.enum(["manual", "agent"]), dueAt: timestamp.optional(),
  dependsOn: z.array(id).max(200), workflowRunId: id.optional(),
  workflowStatus: z.enum(["dispatching", "queued", "running", "waiting_approval", "paused", "completed", "failed", "canceled"]).optional(),
  executionError: z.string().max(4_000).optional(), dispatchedAt: timestamp.optional(), dispatchAttempt: count,
  createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp.optional(),
  workItemStatus: canonicalWorkItemSurfaceSchema.shape.status,
  workItem: canonicalWorkItemSurfaceSchema,
}).strict().superRefine((value, context) => {
  if (value.workItem.status.sourceId !== value.id || value.workItem.status.sourceAuthority !== "legacy_project_task" || JSON.stringify(value.workItemStatus) !== JSON.stringify(value.workItem.status)) issue(context, "The canonical task surface does not match its legacy task identity.");
});
export const nativeMeetingCommitmentResolveResponseSchema = z.object({
  context: nativeMeetingContextSchema, commitment: nativeMeetingCommitmentViewSchema,
  workItem: nativeMeetingCreatedWorkItemSchema.optional(), draft: messageDraftSchema.nullable().optional(),
  meeting: meetingRevisionSchema.optional(),
  serviceReceipt: serviceReceipt("app.meetings.commitments.resolve", "mutation"),
}).strict().superRefine((value, context) => {
  checkOutcome(value, context);
  const { proposal, resolution } = value.commitment;
  if (!resolution || proposal.workspaceId !== value.context.workspaceId) { issue(context, "Resolution response requires a resolved proposal in the exact workspace."); return; }
  if (resolution.decision === "dismissed" && (value.workItem !== undefined || value.meeting !== undefined || value.draft !== undefined)) issue(context, "Dismissed proposal cannot claim downstream effects.");
  if (Boolean(value.workItem) !== Boolean(value.meeting)) issue(context, "Initial conversion returns both task and meeting; replay omits both.");
  if (value.workItem && (value.workItem.id !== resolution.workItemId || value.workItem.projectId !== proposal.projectId || value.workItem.tenantId !== proposal.tenantId)) issue(context, "Returned task differs from the immutable resolution target.");
  if (value.meeting && (value.meeting.meetingId !== proposal.meetingId || value.meeting.meetingRevisionId !== resolution.meetingRevisionId || value.meeting.tenantId !== proposal.tenantId || value.meeting.workspaceId !== proposal.workspaceId)) issue(context, "Returned meeting differs from the resolution revision.");
  if (value.draft && (value.draft.id !== resolution.draftId || value.draft.policyId !== resolution.communicationPolicyId)) issue(context, "Returned draft differs from the confirmed policy and draft identities.");
});

const errorText = z.string().min(1).max(4_000);
const validationMessages = z.array(errorText).max(100);
const validationDetails = z.object({
  formErrors: validationMessages,
  fieldErrors: z.record(z.string().max(240), validationMessages).refine((value) => Object.keys(value).length <= 100),
}).strict();
export const nativeMeetingErrorResponseSchema = z.object({
  error: errorText, message: errorText.optional(), details: validationDetails.optional(),
  code: z.string().min(1).max(160).optional(), requestId: z.string().uuid().optional(),
  reconciliation: meetingResolutionReconciliationSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.reconciliation && value.code !== "meeting_commitment_reconciliation_required") issue(context, "Resolution progress requires its exact conflict code.");
});

// A wire shape establishes no authority. Bind reads to the freshly validated
// native session and selected workspace, preserving legitimate shared meetings.
export type NativeMeetingReadScope = Readonly<{
  tenantId: string; workspaceId: string; canonicalActorId: string;
  requestActorId: string; meetingId?: string;
}>;
function scopeMeeting(meeting: MeetingRevision, scope: NativeMeetingReadScope, context: z.RefinementCtx) {
  if (meeting.tenantId !== scope.tenantId || meeting.workspaceId !== scope.workspaceId || scope.meetingId && meeting.meetingId !== scope.meetingId || meeting.effectiveAccessClass === "owner_private" && meeting.ownerActorId !== scope.canonicalActorId) issue(context, "The meeting does not match the current authorized read scope.");
}
export function nativeMeetingListResponseForScopeSchema(scope: NativeMeetingReadScope) {
  return nativeMeetingListResponseSchema.superRefine((value, context) => {
    if (value.context.workspaceId !== scope.workspaceId) issue(context, "Response workspace changed.");
    value.meetings.forEach((meeting) => scopeMeeting(meeting, scope, context));
  });
}
export function nativeMeetingReadResponseForScopeSchema(scope: NativeMeetingReadScope) {
  return nativeMeetingReadResponseSchema.superRefine((value, context) => {
    if (value.context.workspaceId !== scope.workspaceId) issue(context, "Response workspace changed.");
    scopeMeeting(value.meeting, scope, context);
    for (const source of value.linkedSources) {
      if (source.media?.output && ![scope.canonicalActorId, scope.requestActorId].includes(source.media.output.ownerActorId)) issue(context, "The readable media owner does not match the current request owner pair.");
    }
  });
}
export function nativeMeetingCommitmentsResponseForScopeSchema(scope: NativeMeetingReadScope) {
  return nativeMeetingCommitmentsResponseSchema.superRefine((value, context) => {
    if (value.context.workspaceId !== scope.workspaceId || scope.meetingId && value.meeting.meetingId !== scope.meetingId) issue(context, "Commitment read target changed.");
    for (const view of value.commitments) if (view.proposal.tenantId !== scope.tenantId) issue(context, "Proposal tenant changed.");
    for (const policy of value.eligiblePolicies) if (policy.tenantId !== scope.tenantId || policy.ownerActorId !== scope.requestActorId) issue(context, "Communication policy belongs to a different request owner.");
  });
}

// The existing complete route's request. It currently has neither an expected
// meeting/consent revision nor a required Idempotency-Key; do not imply either.
export const nativeMeetingRecordingCompleteRequestSchema = z.object({
  meetingId: z.string().regex(/^meeting:[0-9a-f-]{36}$/).optional(),
  ...requestWorkspace,
  languageHints: z.array(z.string().trim().min(2).max(35).regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/)).max(12).default([]),
  speakerMappings: z.array(captureSpeakerMappingSchema).max(40).default([]),
  rawAudioRetention: captureRawAudioRetentionSchema.default({ mode: "retain" }),
}).strict();
export const nativeMeetingCalendarSyncQuerySchema = z.object({
  source: z.literal("calendar"), connectionId: z.string().uuid().optional(),
}).strict();
// This existing Capture operation is separate from Meeting source processing:
// multipart `audio`, <=10 MiB, no meeting linkage or consent receipt.
export const nativeMeetingVoiceTranscriptionResponseSchema = z.object({
  text: z.string().max(100_000), model: z.string().min(1).max(160), fallbackUsed: z.boolean(),
}).strict();

// Proposed WHITELIST PROJECTIONS, not today's recording-complete/sync wire
// envelopes. Keep these out of nativeMeetingContractSchemas until the server
// implements/reviews a native-only projection. Opaque metadata, segment audio,
// job payloads, OAuth cursors and credentials have no JsonObject fallback here.
export const proposedNativeMeetingRecordingReceiptSchema = z.object({
  id: z.string().min(1).max(200), tenantId: z.string().min(1).max(120),
  actorId: z.string().min(1).max(320), status: z.enum(["recording", "processing", "ready", "failed"]),
  segmentCount: z.number().int().min(0).max(1_440),
  durationMs: z.number().int().min(0).max(86_400_000),
  byteCount: z.number().int().min(0).max(1_073_741_824), updatedAt: timestamp,
}).strict();
export const nativeMeetingMediaHeadSchema = z.object({
  tenantId: z.string().min(1).max(120), ownerActorId: z.string().min(1).max(320),
  recordingId: z.string().min(1).max(200), meetingId: meetingId.optional(),
  processingStatus, processingGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  operationJobId: id, output: captureMediaOutputSchema.optional(),
  rawAudioRetention: captureRawAudioRetentionSchema, rawAudioDeletedAt: timestamp.optional(),
  lastErrorSha256: sha.optional(), createdAt: timestamp, updatedAt: timestamp,
}).strict().superRefine((value, context) => {
  const output = value.output;
  if (output && (output.tenantId !== value.tenantId || output.ownerActorId !== value.ownerActorId || output.recordingId !== value.recordingId || output.meetingId !== value.meetingId)) issue(context, "Media head and output identity differ.");
});
export const proposedNativeMeetingProcessingJobSchema = z.object({
  id, type: z.literal("capture.media.recording.process"),
  status: z.enum(["queued", "running", "completed", "failed", "canceled"]),
  quarantined: z.literal(true).optional(), priority: z.number().int().min(0).max(100),
  attempt: count, maxAttempts: z.number().int().min(1).max(100),
  runAt: timestamp, lastError: z.string().max(4_000).optional(),
  createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp.optional(),
}).strict().superRefine((value, context) => {
  if (value.quarantined && value.status !== "failed") issue(context, "A quarantined public job must be failed.");
});
export const proposedNativeMeetingRecordingCompleteResponseSchema = z.object({
  recording: proposedNativeMeetingRecordingReceiptSchema,
  media: nativeMeetingMediaHeadSchema, job: proposedNativeMeetingProcessingJobSchema,
}).strict().superRefine((value, context) => {
  if (value.recording.id !== value.media.recordingId || value.recording.tenantId !== value.media.tenantId || value.recording.actorId !== value.media.ownerActorId || value.job.id !== value.media.operationJobId) issue(context, "Recording, media and job identities differ.");
});
export const proposedNativeMeetingCalendarSyncResponseSchema = z.object({
  provider: z.literal("google"), status: z.enum(["partial", "healthy", "error"]),
  imported: count, removed: count, cursorAdvanced: z.boolean(),
  sources: z.array(z.object({
    source: z.literal("calendar"), status: z.enum(["syncing", "healthy", "error"]),
    backfillState: z.enum(["unknown", "in_progress", "complete"]),
    lastAttemptedAt: timestamp, lastSuccessfulAt: timestamp.optional(),
    failureCode: z.enum(["none", "provider_unauthorized", "provider_forbidden", "provider_rate_limited", "provider_unavailable", "processing_failed"]).optional(), imported: count, removed: count,
    error: z.string().max(4_000).optional(),
  }).strict()).max(1),
  error: z.string().max(4_000).optional(),
  grant: z.object({ id: z.string().uuid(), provider: z.literal("google") }).strict(),
}).strict();

export const nativeMeetingContractSchemas = Object.freeze({
  NativeMeetingListQuery: nativeMeetingListQuerySchema,
  NativeMeetingReadQuery: nativeMeetingReadQuerySchema,
  NativeMeetingCreateRequest: nativeMeetingCreateRequestSchema,
  NativeMeetingUpdateRequest: nativeMeetingUpdateRequestSchema,
  NativeMeetingCommitmentProposeRequest: nativeMeetingCommitmentProposeRequestSchema,
  NativeMeetingCommitmentResolveRequest: nativeMeetingCommitmentResolveRequestSchema,
  NativeMeetingListResponse: nativeMeetingListResponseSchema,
  NativeMeetingReadResponse: nativeMeetingReadResponseSchema,
  NativeMeetingCreateResponse: nativeMeetingCreateResponseSchema,
  NativeMeetingUpdateResponse: nativeMeetingUpdateResponseSchema,
  NativeMeetingCommitmentsResponse: nativeMeetingCommitmentsResponseSchema,
  NativeMeetingCommitmentProposeResponse: nativeMeetingCommitmentProposeResponseSchema,
  NativeMeetingCommitmentResolveResponse: nativeMeetingCommitmentResolveResponseSchema,
  NativeMeetingErrorResponse: nativeMeetingErrorResponseSchema,
});
export type NativeMeetingReadResponse = z.infer<typeof nativeMeetingReadResponseSchema>;
export type NativeMeetingCommitmentsResponse = z.infer<typeof nativeMeetingCommitmentsResponseSchema>;

const googleCoverage = z.object({
  schemaVersion: z.literal(1), status: z.enum(["syncing", "healthy", "error"]),
  backfillState: z.enum(["unknown", "in_progress", "complete"]),
  lastAttemptedAt: timestamp, lastSuccessfulAt: timestamp.optional(),
  failureCode: z.enum(["none", "provider_unauthorized", "provider_forbidden", "provider_rate_limited", "provider_unavailable", "processing_failed"]).optional(),
}).strict();
export const nativeMeetingGoogleGrantSchema = z.object({
  id: z.string().uuid(), tenantId: z.string().min(1).max(120), actorId: z.string().min(1).max(320),
  provider: z.literal("google"), accountEmail: z.string().email().max(320).optional(),
  connectionLabel: z.string().min(1).max(120).optional(), connectionPurpose: z.enum(["personal", "work"]).optional(),
  scopes: z.array(z.string().min(1).max(500)).max(100), status: z.enum(["active", "revoked"]),
  authorizationGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), expiresAt: timestamp.optional(),
  syncStatus: z.enum(["idle", "syncing", "healthy", "error"]).optional(), syncError: z.string().max(4_000).optional(),
  lastSyncedAt: timestamp.optional(), syncedItems: count.optional(), syncFailureCount: count.optional(),
  syncRetryAt: timestamp.optional(), sourceCoverage: z.object({
    mail: googleCoverage.optional(), calendar: googleCoverage.optional(), drive: googleCoverage.optional(),
  }).strict().optional(), createdAt: timestamp, updatedAt: timestamp,
}).strict();
// Calendar-only current response, including the actual public grant fields.
// No cursor or OAuth token is part of that public grant. Bounds must also be
// applied by the server before future enrollment; this is not yet registered.
export const nativeMeetingCalendarSyncResponseSchema = proposedNativeMeetingCalendarSyncResponseSchema
  .extend({ grant: nativeMeetingGoogleGrantSchema }).strict()
  .superRefine((value, context) => {
    if (value.imported !== value.sources.reduce((sum, source) => sum + source.imported, 0) || value.removed !== value.sources.reduce((sum, source) => sum + source.removed, 0)) issue(context, "Sync totals do not match returned calendar source counts.");
  });
