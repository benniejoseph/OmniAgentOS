import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  meetingCreateServiceInputSchema,
  meetingUpdateServiceInputSchema,
  meetingListServiceInputSchema,
  meetingCommitmentProposeServiceInputSchema,
  meetingCommitmentResolveServiceInputSchema,
} from "@/lib/app-services/meetings";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { buildMeetingRevision, type MeetingDefinitionInput } from "@/lib/meetings/contracts";
import {
  meetingCommitmentProposalId, meetingCommitmentResolutionId,
  withMeetingCommitmentProposalDigest, withMeetingCommitmentResolutionDigest,
} from "@/lib/meetings/commitment-contracts";
import { mediaCitationForTurn, mediaTurnId, withCaptureMediaOutputDigest } from "@/lib/capture/media-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  nativeMeetingCalendarSyncResponseSchema,
  nativeMeetingCommitmentProposeRequestSchema,
  nativeMeetingCommitmentProposeResponseSchema,
  nativeMeetingCommitmentResolveRequestSchema,
  nativeMeetingCommitmentResolveResponseSchema,
  nativeMeetingCommitmentViewSchema,
  nativeMeetingCommitmentsResponseForScopeSchema,
  nativeMeetingCommitmentsResponseSchema,
  nativeMeetingContextSchema,
  nativeMeetingContractSchemas,
  nativeMeetingCreateRequestSchema,
  nativeMeetingCreateResponseSchema,
  nativeMeetingErrorResponseSchema,
  nativeMeetingLinkedSourceSchema,
  nativeMeetingListQuerySchema,
  nativeMeetingListResponseForScopeSchema,
  nativeMeetingListResponseSchema,
  nativeMeetingReadResponseForScopeSchema,
  nativeMeetingReadResponseSchema,
  nativeMeetingRecordingCompleteRequestSchema,
  nativeMeetingUpdateRequestSchema,
  nativeMeetingUpdateResponseSchema,
  nativeMeetingVoiceTranscriptionResponseSchema,
  proposedNativeMeetingRecordingCompleteResponseSchema,
  type NativeMeetingReadScope,
} from "./meeting-contracts";

const tenantId = "tenant-a", workspaceId = "workspace:tenant-a";
const actorId = "actor:11111111-1111-4111-8111-111111111111", requestActorId = "owner@example.test";
const meetingId = "meeting:22222222-2222-4222-8222-222222222222";
const now = "2026-10-04T10:00:00.000Z", hash = "a".repeat(64);
const scope: NativeMeetingReadScope = { tenantId, workspaceId, canonicalActorId: actorId, requestActorId, meetingId };
const context = { scope: "workspace", workspaceId, accessLevel: "contributor", canWrite: true, authoritySha256: hash };
function definition(): MeetingDefinitionInput {
  return {
    title: "Native meeting", summary: "Exact reviewed source", status: "scheduled",
    scheduledStartAt: now, scheduledEndAt: "2026-10-04T11:00:00.000Z",
    actualStartAt: null, actualEndAt: null, timezone: "UTC", location: "", projectId: "project-one",
    declaredAccessClass: "owner_private",
    participants: [{ participantId: "participant:owner", displayName: "Owner", email: requestActorId, entityId: null, role: "organizer", response: "accepted", attendeeConsent: "granted", recordingConsent: "granted", consentCapturedAt: now, source: "manual" }],
    sourceLinks: [{ linkId: "link:recording", kind: "capture_recording", sourceId: "recording-one", sourceRevisionId: "capture-recording-revision:one", sourceRevisionSha256: hash, sourceAuthoritySha256: hash, accessClass: "owner_private", mediaRole: "recording", label: "Recorded source" }],
    entityLinks: [], decisions: [], commitments: [], followUps: [],
  };
}
function meeting(options: { tenant?: string; owner?: string; revision?: number; shared?: boolean } = {}) {
  const draft: MeetingDefinitionInput = options.shared
    ? { ...definition(), declaredAccessClass: "workspace_members", sourceLinks: [] }
    : definition();
  return buildMeetingRevision({ tenantId: options.tenant ?? tenantId, workspaceId, ownerActorId: options.owner ?? actorId, meetingId, revision: options.revision ?? 1, definition: draft, revisedAt: now });
}
function source() {
  return { linkId: "link:recording", kind: "capture_recording", sourceId: "recording-one", mediaRole: "recording", label: "Recorded source", revisionState: "exact", status: "ready", mediaType: "audio/webm", durationMs: 1000, byteCount: 100, updatedAt: now, transcript: "A reviewed statement", transcriptTruncated: false, media: null, segments: [{ segmentIndex: 0, mimeType: "audio/webm", durationMs: 1000 }] };
}
function receipt(operation: Parameters<typeof getAppServiceOperationContract>[0], data: unknown, resourceCount = 1) {
  const contract = getAppServiceOperationContract(operation);
  const body = { schemaVersion: 1, receiptKind: "app_service_receipt", boundaryVersion: "p9.1-app-service-boundary:1", operation, action: contract.action, resourceType: contract.resourceType, accessMode: contract.accessMode, eventContract: contract.eventContract, authoritySha256: hash, idempotencyKeySha256: contract.accessMode === "mutation" ? hash : null, outcomeSha256: canonicalJsonSha256(data), resourceCount, occurredAt: now };
  return { ...body, receiptSha256: canonicalJsonSha256(body) };
}
function envelope<T extends object>(operation: Parameters<typeof getAppServiceOperationContract>[0], data: T, count = 1) { return { ...data, serviceReceipt: receipt(operation, data, count) }; }
function detail() { return envelope("app.meetings.show", { context, meeting: meeting(), linkedSources: [source()] }); }
function requestDraft() {
  const value = definition();
  return { ...value, sourceLinks: value.sourceLinks.map(({ linkId, kind, sourceId, mediaRole, label }) => ({ linkId, kind, sourceId, mediaRole, label })) };
}
function proposal(options: { tenant?: string; meetingRevision?: number } = {}) {
  const record = meeting({ revision: options.meetingRevision });
  const identity = { tenantId: options.tenant ?? tenantId, workspaceId, meetingId, mediaRevisionId: "recording-one:media:v1", actionItemId: `media-action:${hash}` };
  return withMeetingCommitmentProposalDigest({
    schemaVersion: 1, contractVersion: "p10.8-meeting-commitment-conversion:1", proposalId: meetingCommitmentProposalId(identity),
    ...identity, meetingRevisionId: record.meetingRevisionId, meetingSha256: record.meetingSha256,
    projectId: "project-one", sourceLinkId: "link:recording", recordingId: "recording-one", mediaOutputSha256: hash, actionItemSha256: hash,
    title: "Prepare the reviewed note", citations: [{ turnId: `media-turn:${hash}`, segmentIndex: 0, startMilliseconds: 0, endMilliseconds: 1000, speakerLabel: "Owner", speakerParticipantId: "participant:owner" }],
    ownership: { participantId: "participant:owner", displayName: "Owner", authority: "explicit_transcript" }, dueDate: { dueAt: null, authority: "confirmation_required" }, proposedByActorId: actorId, proposedAt: now,
  });
}
function resolved(decision: "confirmed" | "dismissed" = "confirmed") {
  const candidate = proposal();
  return { proposal: candidate, resolution: withMeetingCommitmentResolutionDigest({
    schemaVersion: 1, contractVersion: "p10.8-meeting-commitment-conversion:1", resolutionId: meetingCommitmentResolutionId(candidate.proposalId), proposalId: candidate.proposalId, proposalSha256: candidate.proposalSha256, decision,
    ownerParticipantId: decision === "confirmed" ? "participant:owner" : null, ownerDisplayName: decision === "confirmed" ? "Owner" : null, ownershipAuthority: decision === "confirmed" ? "explicit_transcript" : null,
    dueAt: null, dueDateAuthority: null, workItemId: decision === "confirmed" ? "task-one" : null, draftId: null, communicationPolicyId: null,
    meetingRevisionId: decision === "confirmed" ? `${meetingId}:v2` : null, resolvedByActorId: actorId, resolvedAt: now,
  }) };
}
function commitments(options: { tenant?: string; currentRevision?: number } = {}) {
  const current = meeting({ revision: options.currentRevision });
  return envelope("app.meetings.commitments.list", {
    context, meeting: { meetingId, meetingRevisionId: current.meetingRevisionId, revision: current.revision, title: current.title, projectId: current.projectId, participants: current.participants },
    commitments: [{ proposal: proposal({ tenant: options.tenant }), resolution: null }], eligiblePolicies: [],
  });
}
function mediaOutput(options: { tenant?: string; owner?: string; target?: string } = {}) {
  const raw = { segmentId: "segment-one", segmentIndex: 0, sourceAudioSha256: hash, startMilliseconds: 0, endMilliseconds: 1000, languageTag: "en-US", speaker: { label: "Owner", identity: "known" as const, participantId: "participant:owner", displayName: "Owner" }, text: "Reviewed statement" };
  const turn = { turnId: mediaTurnId(raw), ...raw }, citation = mediaCitationForTurn(turn);
  return withCaptureMediaOutputDigest({ schemaVersion: 1, tenantId: options.tenant ?? tenantId, ownerActorId: options.owner ?? requestActorId, recordingId: "recording-one", meetingId: options.target ?? meetingId, mediaRevision: 1, mediaRevisionId: "recording-one:media:v1", sourceAudioManifestSha256: hash, transcriptionModel: "test", extractionModel: "test", languageTags: ["en-US"], turns: [turn], chapters: [], summary: { text: "Reviewed statement", citations: [citation] }, actionItems: [], decisions: [], warnings: [], rawAudioRetention: { mode: "retain" }, processedAt: now });
}

function policy(changes: Record<string, unknown> = {}) {
  const body = {
    version: "p9.14-governed-communication:1", id: "contact_policy:55555555-5555-4555-8555-555555555555",
    tenantId, ownerActorId: requestActorId, personRef: "participant:owner", displayName: "Owner",
    channel: "email", address: requestActorId, relationship: "colleague", allowedPurposes: ["follow_up"],
    allowedDisclosure: "relationship_context", consent: "explicit", approvalMode: "always", senderIdentity: "connected_account",
    maxDeliveriesPerDay: 1, quietHours: { enabled: false, timeZone: "UTC", start: "22:00", end: "07:00" },
    status: "active", optOutReason: null, lifecycleRevision: 1, createdAt: now, updatedAt: now,
    ...changes,
  };
  return { ...body, policySha256: canonicalJsonSha256(body) };
}
function createdTask() {
  const status = { schemaVersion: 1, authority: "canonical_work_item_v1", persistence: "postgres", workspaceId,
    projectId: "work-project:one", workItemId: "work-item:one", kind: "task", sourceAuthority: "legacy_project_task",
    sourceId: "task-one", status: "preview", sourceStatus: "open", statusRevision: 1, updatedAt: now };
  const workItem = {
    version: "p11.4-work-item-surface:1",
    projection: { authority: "canonical_work_item_v1", sha256: hash, sourceRevisionSha256: hash }, status,
    assignment: { authority: "canonical_work_item_v1", agents: [] },
    artifacts: { authority: "canonical_work_item_v1", count: 0, items: [] },
    execution: { authority: "governed_workflow_v1", availability: "not_started", workflowRunId: null, sourceStatus: null, currentStep: null, completedSteps: 0, totalSteps: 0, progressPercent: null, updatedAt: null },
    cost: { authority: "ai_usage_ledger_v1", state: "not_recorded", usageReceiptCount: 0, unknownCostReceiptCount: 0, totalTokens: 0, knownEstimatedCostMicrousd: 0 },
  };
  return { id: "task-one", tenantId, projectId: "project-one", title: "Reviewed commitment", detail: "Exact source",
    status: "open", priority: "medium", agentId: "atlas", position: 0, origin: "manual", dependsOn: [], dispatchAttempt: 0,
    createdAt: now, updatedAt: now, workItemStatus: status, workItem };
}

describe("standalone native Meeting contract candidates", () => {
  it("matches the authoritative list and create request parsers including defaults", () => {
    for (const value of [{}, { limit: 200 }, { limit: 201 }, { status: "invented" }, { tenantId: "foreign" }]) expect(nativeMeetingListQuerySchema.safeParse(value).success).toBe(meetingListServiceInputSchema.safeParse(value).success);
    for (const value of [requestDraft(), { ...requestDraft(), workspaceId }, { ...requestDraft(), ownerActorId: actorId }, { ...requestDraft(), meetingId }, { ...requestDraft(), title: "" }]) {
      const actual = meetingCreateServiceInputSchema.safeParse(value), candidate = nativeMeetingCreateRequestSchema.safeParse(value);
      expect(candidate.success).toBe(actual.success); if (candidate.success && actual.success) expect(candidate.data).toEqual(actual.data);
    }
  });
  it("preserves real update CAS and excludes route identity from the body", () => {
    for (const expectedRevision of [1, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const value = { ...requestDraft(), expectedRevision };
      expect(nativeMeetingUpdateRequestSchema.safeParse(value).success).toBe(meetingUpdateServiceInputSchema.safeParse({ ...value, meetingId }).success);
    }
    expect(nativeMeetingUpdateRequestSchema.safeParse(requestDraft()).success).toBe(false);
    expect(nativeMeetingUpdateRequestSchema.safeParse({ ...requestDraft(), expectedRevision: 1, meetingId }).success).toBe(false);
  });
  it("matches exact proposal and confirmation/dismissal service request unions", () => {
    const proposed = { mediaRevisionId: "recording-one:media:v1", actionItemId: `media-action:${hash}` };
    const { meetingId: serviceTarget, ...serviceBody } = meetingCommitmentProposeServiceInputSchema.parse({ ...proposed, meetingId });
    expect(serviceTarget).toBe(meetingId);
    expect(nativeMeetingCommitmentProposeRequestSchema.parse(proposed)).toEqual(serviceBody);
    for (const body of [
      { proposalId: proposal().proposalId, expectedProposalSha256: hash, decision: "dismissed" },
      { proposalId: proposal().proposalId, expectedProposalSha256: hash, decision: "confirmed", ownerParticipantId: "participant:owner", dueAt: null },
      { proposalId: proposal().proposalId, expectedProposalSha256: hash, decision: "dismissed", ownerParticipantId: "participant:owner" },
      { proposalId: proposal().proposalId, expectedProposalSha256: hash, decision: "confirmed", expectedRevision: 9 },
    ]) expect(nativeMeetingCommitmentResolveRequestSchema.safeParse(body).success).toBe(meetingCommitmentResolveServiceInputSchema.safeParse({ ...body, meetingId }).success);
  });
  it("rejects caller-supplied source authority and consent without its required evidence", () => {
    const draft = requestDraft();
    expect(nativeMeetingCreateRequestSchema.safeParse({ ...draft, sourceLinks: definition().sourceLinks }).success).toBe(false);
    expect(nativeMeetingCreateRequestSchema.safeParse({ ...draft, participants: [{ ...draft.participants[0], consentCapturedAt: null }] }).success).toBe(false);
  });
  it("reads exact immutable revisions and source states, rather than arbitrary JSON", () => {
    expect(nativeMeetingReadResponseSchema.parse(detail()).meeting.meetingRevisionId).toBe(`${meetingId}:v1`);
    expect(nativeMeetingReadResponseSchema.safeParse({ ...detail(), extra: true }).success).toBe(false);
    expect(nativeMeetingReadResponseSchema.safeParse({ context, meeting: { id: meetingId }, linkedSources: [] }).success).toBe(false);
    expect(nativeMeetingContextSchema.safeParse({ ...context, accessLevel: "reader" }).success).toBe(false);
  });
  it("accepts actual create/PATCH envelopes only with their own receipt operation", () => {
    const data = { context, meeting: meeting(), linkedSources: [source()] };
    expect(nativeMeetingCreateResponseSchema.safeParse(envelope("app.meetings.create", data)).success).toBe(true);
    expect(nativeMeetingUpdateResponseSchema.safeParse(envelope("app.meetings.update", data)).success).toBe(true);
    expect(nativeMeetingUpdateResponseSchema.safeParse(envelope("app.meetings.create", data)).success).toBe(false);
  });
  it("rejects invalid immutable revision, consent and source digests", () => {
    for (const change of [{ meetingRevisionId: `${meetingId}:v9` }, { consentSnapshotSha256: "f".repeat(64) }, { meetingSha256: "f".repeat(64) }]) {
      const value = detail(); value.meeting = { ...value.meeting, ...change };
      expect(nativeMeetingReadResponseSchema.safeParse(value).success).toBe(false);
    }
  });
  it("binds trusted current tenant and exact owner-private actor without excluding valid shared reads", () => {
    const strict = nativeMeetingReadResponseForScopeSchema(scope);
    expect(strict.safeParse(detail()).success).toBe(true);
    for (const options of [{ tenant: "other" }, { owner: "actor:33333333-3333-4333-8333-333333333333" }]) {
      const data = { context, meeting: meeting(options), linkedSources: [source()] };
      expect(strict.safeParse(envelope("app.meetings.show", data)).success).toBe(false);
    }
    expect(strict.safeParse(envelope("app.meetings.show", { context, meeting: meeting({ shared: true, owner: "actor:33333333-3333-4333-8333-333333333333" }), linkedSources: [] })).success).toBe(true);
  });
  it("bounded lists reject duplicates, wrong counts and foreign workspace records", () => {
    const list = envelope("app.meetings.list", { context, meetings: [meeting()] });
    expect(nativeMeetingListResponseForScopeSchema(scope).safeParse(list).success).toBe(true);
    expect(nativeMeetingListResponseSchema.safeParse(envelope("app.meetings.list", { context, meetings: [meeting(), meeting()] }, 2)).success).toBe(false);
    expect(nativeMeetingListResponseSchema.safeParse(envelope("app.meetings.list", { context, meetings: [] }, 1)).success).toBe(false);
    expect(nativeMeetingListResponseSchema.safeParse(envelope("app.meetings.list", { context: { ...context, workspaceId: "workspace:other" }, meetings: [meeting()] })).success).toBe(false);
    expect(nativeMeetingListResponseSchema.safeParse(envelope("app.meetings.list", { context, meetings: Array.from({ length: 201 }, () => meeting()) }, 201)).success).toBe(false);
  });
  it("linked sources must match exact declared identities; unknown is not empty or exact", () => {
    const value = detail();
    expect(nativeMeetingReadResponseSchema.safeParse({ ...value, linkedSources: [{ ...source(), sourceId: "other-recording" }] }).success).toBe(false);
    expect(nativeMeetingReadResponseSchema.safeParse({ ...value, linkedSources: [] }).success).toBe(false);
    expect(nativeMeetingLinkedSourceSchema.safeParse({ ...source(), revisionState: "changed" }).success).toBe(false);
    const unavailable = { ...source(), revisionState: "unavailable", status: null, mediaType: null, durationMs: null, byteCount: null, updatedAt: null, transcript: null, media: null, segments: [] };
    expect(nativeMeetingReadResponseSchema.safeParse(envelope("app.meetings.show", { context, meeting: value.meeting, linkedSources: [unavailable] })).success).toBe(true);
  });
  it("reuses media digest/citation checks and rejects foreign meeting or readable owner output", () => {
    for (const options of [{}, { tenant: "foreign" }, { owner: "foreign@example.test" }, { target: "meeting:33333333-3333-4333-8333-333333333333" }]) {
      const linked = { ...source(), media: { processingStatus: "ready", operationJobId: "job-one", rawAudioDeletedAt: null, updatedAt: now, output: mediaOutput(options) } };
      const data = envelope("app.meetings.show", { context, meeting: meeting(), linkedSources: [linked] });
      expect(nativeMeetingReadResponseForScopeSchema(scope).safeParse(data).success).toBe(Object.keys(options).length === 0);
    }
    const output = mediaOutput(); output.outputSha256 = "f".repeat(64);
    expect(nativeMeetingLinkedSourceSchema.safeParse({ ...source(), media: { processingStatus: "ready", operationJobId: "job-one", rawAudioDeletedAt: null, updatedAt: now, output } }).success).toBe(false);
  });
  it("keeps historical proposal revision separate from the current commitment summary", () => {
    expect(nativeMeetingCommitmentsResponseSchema.safeParse(commitments({ currentRevision: 2 })).success).toBe(true);
    expect(nativeMeetingCommitmentsResponseForScopeSchema(scope).safeParse(commitments({ tenant: "foreign" })).success).toBe(false);
    const value = commitments(); value.meeting.meetingRevisionId = `${meetingId}:v9`;
    expect(nativeMeetingCommitmentsResponseSchema.safeParse(value).success).toBe(false);
  });
  it("resolution must refer to the exact proposal digest and initial/replay shape", () => {
    const view = resolved();
    expect(nativeMeetingCommitmentViewSchema.safeParse(view).success).toBe(true);
    const other = proposal({ meetingRevision: 2 });
    expect(nativeMeetingCommitmentViewSchema.safeParse({ proposal: other, resolution: view.resolution }).success).toBe(false);
    expect(nativeMeetingCommitmentResolveResponseSchema.safeParse(envelope("app.meetings.commitments.resolve", { context, commitment: view })).success).toBe(true);
    expect(nativeMeetingCommitmentResolveResponseSchema.safeParse(envelope("app.meetings.commitments.resolve", { context, commitment: resolved("dismissed") })).success).toBe(true);
    expect(nativeMeetingCommitmentResolveResponseSchema.safeParse(envelope("app.meetings.commitments.resolve", { context, commitment: { proposal: proposal(), resolution: null } })).success).toBe(false);
    expect(nativeMeetingCommitmentResolveResponseSchema.safeParse(envelope("app.meetings.commitments.resolve", { context, commitment: view, meeting: meeting({ revision: 2 }) })).success).toBe(false);
    expect(nativeMeetingCommitmentProposeResponseSchema.safeParse(envelope("app.meetings.commitments.propose", { context, commitment: { proposal: proposal(), resolution: null } })).success).toBe(true);
  });
  it("eligible policies retain exact request ownership and current participant consent", () => {
    const original = commitments();
    const make = (changes: Record<string, unknown> = {}) => envelope("app.meetings.commitments.list", {
      context, meeting: original.meeting, commitments: original.commitments, eligiblePolicies: [policy(changes)],
    });
    const scoped = nativeMeetingCommitmentsResponseForScopeSchema(scope);
    expect(scoped.safeParse(make()).success).toBe(true);
    for (const changes of [{ tenantId: "foreign" }, { ownerActorId: "other@example.test" }, { consent: "unknown" }, { address: "other@example.test" }, { status: "paused" }, { allowedDisclosure: "public_only" }, { allowedPurposes: ["commercial"] }]) {
      expect(scoped.safeParse(make(changes)).success).toBe(false);
    }
    const badDigest = policy(); badDigest.policySha256 = "f".repeat(64);
    expect(scoped.safeParse(envelope("app.meetings.commitments.list", { context, meeting: original.meeting, commitments: original.commitments, eligiblePolicies: [badDigest] })).success).toBe(false);
  });
  it("initial resolution binds both task identities and exact saved revision", () => {
    const initial = { context, commitment: resolved(), workItem: createdTask(), meeting: meeting({ revision: 2 }), draft: null };
    const schema = nativeMeetingCommitmentResolveResponseSchema;
    expect(schema.safeParse(envelope("app.meetings.commitments.resolve", initial)).success).toBe(true);
    for (const change of [{ id: "foreign-task" }, { tenantId: "foreign" }, { projectId: "foreign-project" }]) {
      expect(schema.safeParse(envelope("app.meetings.commitments.resolve", { ...initial, workItem: { ...initial.workItem, ...change } })).success).toBe(false);
    }
    expect(schema.safeParse(envelope("app.meetings.commitments.resolve", { ...initial, meeting: meeting({ revision: 3 }) })).success).toBe(false);
    expect(schema.safeParse(envelope("app.meetings.commitments.resolve", { context, commitment: resolved("dismissed"), draft: null })).success).toBe(false);
  });
  it("an intact receipt must describe the returned body and exact service operation", () => {
    const original = detail();
    expect(nativeMeetingReadResponseSchema.safeParse({ ...original, context: { ...context, authoritySha256: "b".repeat(64) } }).success).toBe(false);
    const { receiptSha256: originalDigest, ...receiptBody } = original.serviceReceipt;
    expect(originalDigest).toHaveLength(64);
    const wrongAction = { ...receiptBody, action: "manage.workflow" };
    expect(nativeMeetingReadResponseSchema.safeParse({ ...original, serviceReceipt: { ...wrongAction, receiptSha256: canonicalJsonSha256(wrongAction) } }).success).toBe(false);
  });
  it("recording completion describes current fields without inventing a consent CAS or idempotency body", () => {
    expect(nativeMeetingRecordingCompleteRequestSchema.parse({ meetingId })).toEqual({ meetingId, languageHints: [], speakerMappings: [], rawAudioRetention: { mode: "retain" } });
    for (const extra of [{ expectedRevision: 1 }, { expectedConsentSnapshotSha256: hash }, { idempotencyKey: "invented" }]) expect(nativeMeetingRecordingCompleteRequestSchema.safeParse({ meetingId, ...extra }).success).toBe(false);
    expect(nativeMeetingRecordingCompleteRequestSchema.safeParse({ rawAudioRetention: { mode: "delete_after_processing", retainUntil: now } }).success).toBe(false);
  });
  it("proposed recording projection rejects arbitrary metadata and job payloads", () => {
    const value = { recording: { id: "recording-one", tenantId, actorId: requestActorId, status: "processing", segmentCount: 1, durationMs: 1000, byteCount: 100, updatedAt: now }, media: { tenantId, ownerActorId: requestActorId, recordingId: "recording-one", meetingId, processingStatus: "queued", processingGeneration: 1, operationJobId: "job-one", rawAudioRetention: { mode: "retain" }, createdAt: now, updatedAt: now }, job: { id: "job-one", type: "capture.media.recording.process", status: "queued", priority: 1, attempt: 0, maxAttempts: 8, runAt: now, createdAt: now, updatedAt: now } };
    expect(proposedNativeMeetingRecordingCompleteResponseSchema.safeParse(value).success).toBe(true);
    expect(proposedNativeMeetingRecordingCompleteResponseSchema.safeParse({ ...value, recording: { ...value.recording, metadata: { arbitrary: true } } }).success).toBe(false);
    expect(proposedNativeMeetingRecordingCompleteResponseSchema.safeParse({ ...value, job: { ...value.job, result: {} } }).success).toBe(false);
    expect(proposedNativeMeetingRecordingCompleteResponseSchema.safeParse({ ...value, media: { ...value.media, recordingId: "other" } }).success).toBe(false);
    expect(Object.keys(nativeMeetingContractSchemas).some((key) => key.includes("RecordingComplete"))).toBe(false);
  });
  it("calendar partial sync is distinct from healthy and does not admit OAuth credentials", () => {
    const value = { provider: "google", status: "partial", imported: 1, removed: 0, cursorAdvanced: true, sources: [{ source: "calendar", status: "syncing", backfillState: "in_progress", lastAttemptedAt: now, imported: 1, removed: 0 }], grant: { id: "44444444-4444-4444-8444-444444444444", tenantId, actorId: requestActorId, provider: "google", scopes: ["https://www.googleapis.com/auth/calendar.readonly"], status: "active", authorizationGeneration: 1, createdAt: now, updatedAt: now } };
    expect(nativeMeetingCalendarSyncResponseSchema.safeParse(value).success).toBe(true);
    expect(nativeMeetingCalendarSyncResponseSchema.safeParse({ ...value, imported: 2 }).success).toBe(false);
    expect(nativeMeetingCalendarSyncResponseSchema.safeParse({ ...value, grant: { ...value.grant, refreshToken: "secret" } }).success).toBe(false);
  });
  it("existing short voice transcription remains separate and bounded", () => {
    expect(nativeMeetingVoiceTranscriptionResponseSchema.safeParse({ text: "Reviewed speech", model: "whisper", fallbackUsed: false }).success).toBe(true);
    expect(nativeMeetingVoiceTranscriptionResponseSchema.safeParse({ text: "x".repeat(100_001), model: "whisper", fallbackUsed: false }).success).toBe(false);
    expect(nativeMeetingVoiceTranscriptionResponseSchema.safeParse({ text: "speech", model: "whisper", fallbackUsed: false, meetingId }).success).toBe(false);
  });
  it("errors admit bounded known fields, never an arbitrary success-like object", () => {
    expect(nativeMeetingErrorResponseSchema.safeParse({ error: "Invalid request", message: "A key is required." }).success).toBe(true);
    expect(nativeMeetingErrorResponseSchema.safeParse({ error: "Invalid meeting request.", details: { formErrors: [], fieldErrors: { expectedRevision: ["Required"] } } }).success).toBe(true);
    expect(nativeMeetingErrorResponseSchema.safeParse({ error: { arbitrary: true } }).success).toBe(false);
    expect(nativeMeetingErrorResponseSchema.safeParse({ error: "failure", current: {} }).success).toBe(false);
  });
  it("accepts bounded pending reconciliation without treating it as a completed resolution", () => {
    const value = commitments();
    const reconciliation = { schemaVersion: 1, requestSha256: hash, decision: "confirmed", state: "uncertain", automaticRetryAllowed: false, createdAt: now,
      phases: [{ phase: "work_started", at: now, resourceId: null, evidenceSha256: null }] };
    const data = { context, meeting: value.meeting, eligiblePolicies: [], commitments: [{ proposal: proposal(), resolution: null, reconciliation }] };
    expect(nativeMeetingCommitmentsResponseSchema.safeParse(envelope("app.meetings.commitments.list", data)).success).toBe(true);
    expect(nativeMeetingCommitmentViewSchema.safeParse({ proposal: proposal(), resolution: null, reconciliation: { ...reconciliation, state: "resolved" } }).success).toBe(false);
    expect(nativeMeetingErrorResponseSchema.safeParse({ error: "Inspect the recorded phases.", code: "meeting_commitment_reconciliation_required", reconciliation }).success).toBe(true);
    expect(nativeMeetingErrorResponseSchema.safeParse({ error: "Inspect the recorded phases.", code: "other_error", reconciliation }).success).toBe(false);
    expect(nativeMeetingCommitmentViewSchema.safeParse({ proposal: proposal(), resolution: null, reconciliation: { ...reconciliation, automaticRetryAllowed: true } }).success).toBe(false);
  });
  it("generates strict named wire documents without publishing these candidates", () => {
    for (const [name, schema] of Object.entries(nativeMeetingContractSchemas)) {
      const document = z.toJSONSchema(schema, { target: "draft-2020-12" });
      expect(document, name).not.toEqual({});
      if (document.type === "object") expect(document.additionalProperties, name).toBe(false);
      expect(JSON.stringify(document), name).not.toContain('"$ref":"JsonObject"');
    }
  });
});
