import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope, runWithManagedDatabaseTransaction } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { getCaptureRecording, prepareCaptureRecordingMediaProcessing } from "@/lib/capture/recordings";
import { getCaptureMediaHead, queueCaptureMediaProcessing, type CaptureMediaHead } from "@/lib/capture/media-store";
import { captureRecordingAudioManifestSha256 } from "@/lib/capture/media-jobs";
import { sha256Json } from "@/lib/capture/media-contracts";
import type { CaptureRecordingDetail } from "@/lib/capture/types";
import { parseMeetingRevision, type MeetingRevision, type MeetingSourceLink } from "@/lib/meetings/contracts";
import { captureRecordingRevisionBody } from "@/lib/meetings/store";
import { enqueueOperationJob, type OperationJobRecord } from "@/lib/operations/job-queue";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { createExecutionScope, deriveExecutionScope, parsePersistedExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import { redactSensitive } from "@/lib/security/context";
import { MEETING_RECORDING_POLICY_SHA256, MeetingRecordingNativeError, buildMeetingRecordingIntent, meetingRecordingAcceptanceId,
  meetingRecordingAcceptanceSchema, meetingRecordingIntentSchema, meetingRecordingProcessingSchema, meetingRecordingReviewSchema,
  meetingRecordingScopeSchema, sealMeetingRecordingAcceptance, sealMeetingRecordingReviewPin,
  type MeetingRecordingAcceptance, type MeetingRecordingIntent, type MeetingRecordingProcessing, type MeetingRecordingRequest,
  type MeetingRecordingScope, type MeetingRecordingReview } from "@/lib/capture/meeting-recording-native-contracts";

type Sql = ReturnType<typeof getSql>;
export type MeetingRecordingNativeAuthority = { scope: MeetingRecordingScope; executionScope?: ExecutionScope };
type Accepted = { intent: MeetingRecordingIntent; acceptance: MeetingRecordingAcceptance; manifest: SourceManifest };
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
const owner = (scope: MeetingRecordingScope) => ({ tenantId: scope.tenantId, actorId: scope.ownerActorId });
function fail(message: string, code = "meeting_recording_conflict", status = 409): never { throw new MeetingRecordingNativeError(code, status, message); }
const segmentManifestSchema = z.object({ id: z.string(), segmentIndex: z.number().int(), mimeType: z.string(), audioSha256: z.string(),
  byteCount: z.number().int(), durationMs: z.number().int(), cachedTranscriptSha256: z.string().nullable() }).strict();
const sourceManifestSchema = z.object({ recordingAuthoritySha256: z.string(), segments: z.array(segmentManifestSchema).max(1_440) }).strict();
const persistedManifestSchema = sourceManifestSchema.extend({ consentSnapshot: z.array(z.record(z.string(), z.unknown())).max(200),
  sourceLinkSnapshot: z.record(z.string(), z.unknown()), recordingPolicy: z.object({ title: z.string(), language: z.string(), tags: z.array(z.string()),
    startedAt: z.string(), source: z.string() }).strict() }).strict();
type SourceManifest = z.infer<typeof persistedManifestSchema>;
function manifest(recording: CaptureRecordingDetail): z.infer<typeof sourceManifestSchema> {
  return { recordingAuthoritySha256: canonicalJsonSha256({ tenantId: recording.tenantId, ownerActorId: recording.actorId, id: recording.id,
    title: recording.title, language: recording.language, tags: recording.tags, startedAt: recording.startedAt, source: recording.source }),
  segments: recording.segments.map((segment) => ({ id: segment.id, segmentIndex: segment.segmentIndex, mimeType: segment.mimeType,
    audioSha256: segment.audioSha256, byteCount: segment.byteCount, durationMs: segment.durationMs,
    cachedTranscriptSha256: segment.mediaTranscript ? canonicalJsonSha256(segment.mediaTranscript) : null })) };
}
const consent = (meeting: MeetingRevision) => meeting.participants.map((item) => ({ participantId: item.participantId, displayName: item.displayName,
  recordingConsent: item.recordingConsent, consentCapturedAt: item.consentCapturedAt }));
async function ready(scope: MeetingRecordingScope) {
  meetingRecordingScopeSchema.parse(scope);
  if (!hasDatabaseUrl()) fail("Native recording processing requires durable database storage.", "meeting_recording_database_required", 503);
  await ensureDatabaseSchema();
}
export function withNativeMeetingRecordingTransaction<T>(scope: MeetingRecordingScope, work: (sql: Sql) => Promise<T>) {
  return runWithDatabaseActorScope(scope.tenantId, [...new Set([scope.ownerActorId, scope.canonicalActorId])], () =>
    getSql().transaction(async (transaction: Sql) => runWithManagedDatabaseTransaction(transaction, () => work(getSql()))) as Promise<T>);
}
async function current(sql: Sql, scope: MeetingRecordingScope, write: boolean, lock = false): Promise<{
  meeting: MeetingRevision; recording: CaptureRecordingDetail; link: MeetingSourceLink; head: CaptureMediaHead | undefined;
}> {
  // The current owner and active membership anchor is required even when an
  // immutable receipt exists; compatibility aliases never become write owners.
  const rows = await sql`SELECT meeting.meeting_snapshot FROM omni_meetings meeting
    JOIN omni_tenant_workspaces workspace ON workspace.tenant_id=meeting.tenant_id AND workspace.workspace_id=meeting.workspace_id AND workspace.state='active'
    JOIN omni_tenant_workspace_memberships membership ON membership.tenant_id=workspace.tenant_id AND membership.workspace_id=workspace.workspace_id
      AND membership.subject_kind='user' AND membership.subject_actor_id=${scope.canonicalActorId} AND membership.state='active'
    WHERE meeting.tenant_id=${scope.tenantId} AND meeting.workspace_id=${scope.workspaceId} AND meeting.meeting_id=${scope.meetingId}
      AND meeting.owner_actor_id=${scope.canonicalActorId}
      AND public.omni_native_private_memory_owner_v1(${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${write})
      AND (NOT ${write} OR membership.access_level IN ('contributor','manager'))
      AND membership.access_level IN ('reader','contributor','manager') LIMIT 2`;
  if (rows.length !== 1) fail("Current owned Meeting authority is unavailable.", "meeting_recording_authority", 403);
  if (lock) {
    await sql`SELECT id FROM omni_capture_recordings WHERE tenant_id=${scope.tenantId} AND actor_id=${scope.ownerActorId} AND id=${scope.recordingId} FOR UPDATE`;
    await sql`SELECT meeting_id FROM omni_meetings WHERE tenant_id=${scope.tenantId} AND workspace_id=${scope.workspaceId}
      AND owner_actor_id=${scope.canonicalActorId} AND meeting_id=${scope.meetingId} FOR UPDATE`;
    await sql`SELECT id FROM omni_capture_segments WHERE tenant_id=${scope.tenantId} AND actor_id=${scope.ownerActorId}
      AND recording_id=${scope.recordingId} ORDER BY segment_index FOR UPDATE`;
    // Re-read after waits; rows observed before acquiring the parent are not a pin.
    return current(sql, scope, write, false);
  }
  const meeting = parseMeetingRevision(rows[0].meeting_snapshot);
  if (!meeting || meeting.ownerActorId !== scope.canonicalActorId) fail("Meeting snapshot is invalid.");
  const recording = await getCaptureRecording(scope.recordingId, owner(scope));
  if (!recording || recording.actorId !== scope.ownerActorId || recording.tenantId !== scope.tenantId) fail("Exact owned recording was not found.", "meeting_recording_not_found", 404);
  const links = meeting.sourceLinks.filter((link) => link.kind === "capture_recording" && link.sourceId === scope.recordingId);
  if (links.length !== 1 || links[0].accessClass !== "owner_private") fail("The exact private recording link is unavailable.", "meeting_recording_source_link", 409);
  const head = await getCaptureMediaHead(scope.recordingId, { tenantId: scope.tenantId, actorId: scope.canonicalActorId });
  return { meeting, recording, link: links[0], head };
}
async function existing(sql: Sql, scope: MeetingRecordingScope, keySha256: string): Promise<Accepted | null> {
  const rows = await sql`SELECT intent,acceptance,source_manifest FROM omni_meeting_recording_processing_acceptances
    WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND idempotency_key_sha256=${keySha256} LIMIT 2`;
  if (!rows.length) return null;
  if (rows.length !== 1) fail("Accepted recording identity is ambiguous.");
  const intent = meetingRecordingIntentSchema.parse(rows[0].intent), acceptance = meetingRecordingAcceptanceSchema.parse(rows[0].acceptance);
  if (!same(intent.scope, scope) || !same(acceptance.scope, scope) || intent.keySha256 !== keySha256 || acceptance.keySha256 !== keySha256 ||
    acceptance.requestSha256 !== canonicalJsonSha256(intent) || acceptance.reviewSha256 !== intent.request.review.reviewSha256 ||
    acceptance.acceptedMediaGeneration !== intent.request.review.mediaGeneration + 1 ||
    acceptance.sourceAudioManifestSha256 !== intent.request.review.sourceAudioManifestSha256) fail("Stored native processing receipt is inconsistent.");
  return { intent, acceptance, manifest: persistedManifestSchema.parse(rows[0].source_manifest) };
}
async function reviewInTransaction(sql: Sql, scope: MeetingRecordingScope): Promise<MeetingRecordingReview> {
  const value = await current(sql, scope, true, true), { recording, meeting, link, head } = value;
  const [row] = await sql`SELECT * FROM omni_capture_recordings WHERE tenant_id=${scope.tenantId} AND actor_id=${scope.ownerActorId} AND id=${scope.recordingId}`;
  const native = await sql`SELECT id FROM omni_meeting_recording_processing_acceptances WHERE tenant_id=${scope.tenantId} AND owner_actor_id=${scope.ownerActorId} AND recording_id=${scope.recordingId}`;
  const jobs = await sql`SELECT status,payload FROM omni_operation_jobs WHERE tenant_id=${scope.tenantId} AND payload->>'actorId'=${scope.ownerActorId}
    AND type IN ('capture.media.segment.transcribe','capture.media.recording.process','knowledge.ingest')
    AND (payload->'request'->>'recordingId'=${scope.recordingId} OR payload->'request'->'processing'->>'recordingId'=${scope.recordingId}
      OR payload->'request'->'metadata'->>'captureRecordingId'=${scope.recordingId}) ORDER BY id LIMIT 1443 FOR UPDATE`;
  const reasons: MeetingRecordingReview["eligibility"]["reasonCodes"] = [];
  if (!recording.segments.length) reasons.push("recording_empty");
  if (recording.segments.some((segment) => segment.rawAudioDeletedAt) || head?.rawAudioDeletedAt) reasons.push("audio_deleted");
  if (!meeting.participants.length || meeting.participants.some((item) => !["granted", "not_required"].includes(item.recordingConsent))) reasons.push("consent_required");
  if (link.sourceRevisionSha256 !== canonicalJsonSha256(captureRecordingRevisionBody(scope.tenantId, row))) reasons.push("source_changed");
  if (native.length || head?.processingStatus === "ready") reasons.push("already_accepted");
  if (jobs.some((job) => ["queued", "running"].includes(String(job.status)))) reasons.push("legacy_processing_pending");
  if (head?.processingStatus === "failed" || jobs.length > 1442 || jobs.some((job) => ["failed","canceled","quarantined"].includes(String(job.status)) &&
    !recording.segments.some((segment) => segment.id === (job.payload as { request?: { segmentId?: string } })?.request?.segmentId && segment.mediaTranscript))) reasons.push("legacy_effect_unconfirmed");
  const source = manifest(recording);
  return meetingRecordingReviewSchema.parse({ pin: sealMeetingRecordingReviewPin({ meetingRevision: meeting.revision, meetingSha256: meeting.meetingSha256,
    sourceLinkId: link.linkId, sourceLinkSha256: canonicalJsonSha256(link), consentSha256: canonicalJsonSha256(consent(meeting)),
    recordingStateSha256: canonicalJsonSha256({ recording: captureRecordingRevisionBody(scope.tenantId, row), source }),
    sourceAudioManifestSha256: captureRecordingAudioManifestSha256(recording), transcriptCheckpointSha256: canonicalJsonSha256(source.segments.map((segment) => [segment.id, segment.cachedTranscriptSha256])),
    mediaGeneration: head?.processingGeneration ?? 0, mediaHeadSha256: head ? canonicalJsonSha256(head) : null, policySha256: MEETING_RECORDING_POLICY_SHA256 }),
    recording: { title: recording.title, status: recording.status, language: recording.language, segmentCount: recording.segmentCount,
      durationMs: recording.durationMs, byteCount: recording.byteCount, cachedTranscripts: recording.segments.filter((segment) => segment.mediaTranscript).length },
    participants: consent(meeting), eligibility: { processable: reasons.length === 0, reasonCodes: [...new Set(reasons)] } });
}
export async function reviewNativeMeetingRecording(authority: MeetingRecordingNativeAuthority) {
  await ready(authority.scope);
  if (authority.executionScope) fail("Review requires read-only authority.", "meeting_recording_authority", 403);
  return withNativeMeetingRecordingTransaction(authority.scope, (sql) => reviewInTransaction(sql, authority.scope));
}
async function observation(sql: Sql, accepted: Accepted): Promise<MeetingRecordingProcessing> {
  const { scope } = accepted.intent, value = await current(sql, scope, false);
  const effects = await sql`SELECT stage,state,checkpoint,updated_at FROM omni_meeting_recording_processing_effects WHERE acceptance_id=${accepted.acceptance.id}`;
  const jobs = await sql`SELECT id,status,updated_at,lease_expires_at FROM omni_operation_jobs WHERE tenant_id=${scope.tenantId}
    AND payload->>'nativeAcceptanceId'=${accepted.acceptance.id}`;
  const extraction = effects.find((effect) => effect.stage === "extract"), knowledge = effects.find((effect) => effect.stage === "knowledge");
  const media = value.head?.output && value.head.operationJobId === accepted.acceptance.operationJobId
    ? { mediaRevisionId: value.head.output.mediaRevisionId, outputSha256: value.head.output.outputSha256 } : null;
  const knowledgeJobId = value.recording.ingestJobId;
  const knowledgeResult = knowledge?.checkpoint as { documentId?: string } | null;
  const blocked = !same(consent(value.meeting), consentFromIntent(accepted, value.meeting)) || canonicalJsonSha256(value.link) !== accepted.intent.request.review.sourceLinkSha256;
  const unknown = effects.some((effect) => effect.state === "unconfirmed") || jobs.some((job) => ["failed", "canceled", "quarantined"].includes(String(job.status)) ||
    job.status === "running" && (!job.lease_expires_at || Date.parse(iso(job.lease_expires_at)) <= Date.now())) || !jobs.length;
  const completed = extraction?.state === "committed" && knowledge?.state === "committed" && media !== null && Boolean(knowledgeResult?.documentId);
  const phase = blocked || effects.some((effect) => effect.state === "blocked") ? "blocked"
    : completed ? "completed" : unknown ? "reconciliation_required" : knowledgeJobId ? "indexing"
      : extraction ? "extracting" : effects.length ? "transcribing" : "queued";
  const latest = [...effects.map((effect) => iso(effect.updated_at)), ...jobs.map((job) => iso(job.updated_at)), accepted.acceptance.acceptedAt].sort().at(-1)!;
  return meetingRecordingProcessingSchema.parse({ phase, completedSegments: value.recording.segments.filter((segment) => segment.mediaTranscript).length,
    totalSegments: accepted.manifest.segments.length, media, knowledge: knowledgeJobId ? { state: knowledge?.state ?? "queued", jobId: knowledgeJobId,
      documentId: knowledgeResult?.documentId ?? null } : null,
    reasonCode: blocked ? "authority_changed" : !completed && unknown ? "provider_effect_unconfirmed" : null, updatedAt: latest, automaticRetryAllowed: false });
}
function consentFromIntent(accepted: Accepted, meeting: MeetingRevision) {
  return canonicalJsonSha256(consent(meeting)) === accepted.intent.request.review.consentSha256 ? consent(meeting) : [];
}
function iso(value: unknown) { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
export async function readNativeMeetingRecording(authority: MeetingRecordingNativeAuthority, keySha256: string) {
  await ready(authority.scope);
  if (authority.executionScope || !/^[a-f0-9]{64}$/.test(keySha256)) fail("Exact read authority and key are required.", "meeting_recording_read_invalid", 400);
  return withNativeMeetingRecordingTransaction(authority.scope, async (sql) => {
    await current(sql, authority.scope, false);
    const found = await existing(sql, authority.scope, keySha256);
    return { acceptance: found?.acceptance ?? null, processing: found ? await observation(sql, found) : null };
  });
}
export async function submitNativeMeetingRecording(input: { authority: MeetingRecordingNativeAuthority; request: MeetingRecordingRequest; idempotencyKey: string }) {
  const { scope } = input.authority; await ready(scope);
  const intent = buildMeetingRecordingIntent({ ...input, scope }), executionScope = parsePersistedExecutionScope(input.authority.executionScope);
  if (!executionScope || executionScope.tenantId !== scope.tenantId || executionScope.initiatingActorId !== scope.ownerActorId ||
    executionScope.executingPrincipalType !== "user" || executionScope.executingPrincipalId !== scope.ownerActorId || executionScope.workspaceId !== scope.workspaceId ||
    executionScope.projectId || executionScope.missionId || executionScope.delegationId || executionScope.contextGrantIds.length || executionScope.capabilityGrantIds.length ||
    executionScope.purpose !== "capture.recording.media.queue" || executionScope.causationId !== scope.recordingId) fail("Exact current recording mutation authority is required.", "meeting_recording_authority", 403);
  if (!same(redactSensitive(intent.request), intent.request)) fail("Reviewed input changes during sensitive-data normalization.");
  return withNativeMeetingRecordingTransaction(scope, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-recording:${scope.tenantId}:${scope.ownerActorId}:${intent.keySha256}`},0))`;
    await current(sql, scope, true, true);
    const prior = await existing(sql, scope, intent.keySha256);
    if (prior) { if (!same(prior.intent, intent)) fail("Idempotency-Key already names another recording request.");
      return { acceptance: prior.acceptance, processing: await observation(sql, prior), replayed: true }; }
    const review = await reviewInTransaction(sql, scope);
    if (!review.eligibility.processable || !same(review.pin, intent.request.review)) fail("The reviewed recording, consent or source state changed. Refresh its review.");
    const value = await current(sql, scope, true), source = { ...manifest(value.recording), consentSnapshot: consent(value.meeting), sourceLinkSnapshot: { ...value.link },
      recordingPolicy: { title: value.recording.title, language: value.recording.language, tags: value.recording.tags, startedAt: value.recording.startedAt, source: value.recording.source } };
    for (const mapping of intent.request.speakerMappings) if (!value.meeting.participants.some((person) => person.participantId === mapping.participantId && person.displayName === mapping.displayName)) fail("Speaker mapping does not name a current participant.");
    const acceptanceId = meetingRecordingAcceptanceId(scope, intent.keySha256);
    const processing = { schemaVersion: 1 as const, recordingId: scope.recordingId, meetingId: scope.meetingId, languageHints: intent.request.languageHints,
      speakerMappings: intent.request.speakerMappings, rawAudioRetention: intent.request.rawAudioRetention };
    const request = { processing, actorId: scope.ownerActorId, sourceAudioManifestSha256: review.pin.sourceAudioManifestSha256 };
    const job = await enqueueOperationJob({ tenantId: scope.tenantId, type: "capture.media.recording.process", dedupeKey: acceptanceId,
      payload: { actorId: scope.ownerActorId, request, requestHash: canonicalJsonSha256(request), executionScope, nativeAcceptanceId: acceptanceId },
      maxAttempts: 1, priority: 1, dedupeMode: "idempotent" }, { sql });
    const acceptance = sealMeetingRecordingAcceptance({ contract: "asael-meeting-recording-acceptance:1", id: acceptanceId, scope, keySha256: intent.keySha256,
      requestSha256: canonicalJsonSha256(intent), reviewSha256: review.pin.reviewSha256, operationJobId: job.id,
      acceptedMediaGeneration: review.pin.mediaGeneration + 1, sourceAudioManifestSha256: review.pin.sourceAudioManifestSha256, acceptedAt: new Date().toISOString() });
    await sql`INSERT INTO omni_meeting_recording_processing_acceptances(id,tenant_id,owner_actor_id,canonical_actor_id,workspace_id,meeting_id,recording_id,
      idempotency_key_sha256,request_sha256,operation_job_id,intent,acceptance,source_manifest,accepted_at)
      VALUES(${acceptance.id},${scope.tenantId},${scope.ownerActorId},${scope.canonicalActorId},${scope.workspaceId},${scope.meetingId},${scope.recordingId},
        ${intent.keySha256},${acceptance.requestSha256},${job.id},${intent}::JSONB,${acceptance}::JSONB,${source}::JSONB,${acceptance.acceptedAt})`;
    await prepareCaptureRecordingMediaProcessing(scope.recordingId, { ...owner(scope), executionScope, nativeAcceptanceId: acceptance.id });
    // The exact accepted alias is already resolved and locked by current().
    // Media owns canonical projections while Capture retains its physical alias.
    const mediaExecutionScope = createExecutionScope({ ...executionScope,initiatingActorId: scope.canonicalActorId,executingPrincipalId: scope.canonicalActorId });
    const head = await queueCaptureMediaProcessing({ tenantId: scope.tenantId,actorId: scope.canonicalActorId,executionScope: mediaExecutionScope,
      request: processing, operationJobId: job.id, nativeAcceptanceId: acceptance.id });
    if (head.processingGeneration !== acceptance.acceptedMediaGeneration) fail("Queued media head did not match the accepted generation.");
    await appendScopedDomainEvent({ id: acceptance.id, streamId: scope.recordingId, type: "meeting.recording.native.accepted", executionScope,
      payload: { acceptanceId: acceptance.id, acceptanceSha256: acceptance.acceptanceSha256, operationJobId: job.id } }, { sql });
    return { acceptance, processing: await observation(sql, { intent, acceptance, manifest: source }), replayed: false };
  });
}

/** Workers receive an immutable reference, never authority supplied by a client. */
export async function loadNativeMeetingRecordingJob(job: OperationJobRecord) {
  const id = job.payload.nativeAcceptanceId;
  if (typeof id !== "string" || !/^meeting-recording-acceptance:[a-f0-9]{64}$/.test(id) || typeof job.payload.actorId !== "string") fail("Native job reference is invalid.");
  await ensureDatabaseSchema();
  const rows = await runWithDatabaseActorScope(job.tenantId, [job.payload.actorId], () => getSql()`SELECT intent,acceptance,source_manifest
    FROM omni_meeting_recording_processing_acceptances WHERE tenant_id=${job.tenantId} AND owner_actor_id=${String(job.payload.actorId)} AND id=${id}`);
  if (rows.length !== 1) fail("Native processing acceptance is unavailable.");
  const intent = meetingRecordingIntentSchema.parse(rows[0].intent), acceptance = meetingRecordingAcceptanceSchema.parse(rows[0].acceptance);
  const source = parsePersistedExecutionScope(job.payload.executionScope);
  const principal = job.type === "capture.media.recording.process"
    ? source?.executingPrincipalType === "user" && source.executingPrincipalId === intent.scope.ownerActorId && source.purpose === "capture.recording.media.queue" && source.causationId === intent.scope.recordingId
    : source?.executingPrincipalType === "system" && source.executingPrincipalId === "background-operations-worker" &&
      source.purpose === (job.type === "capture.media.segment.transcribe" ? "capture.media.segment.transcribe.background" : "capture.media.recording.process.background") && source.causationId === acceptance.operationJobId;
  if (intent.scope.ownerActorId !== job.payload.actorId || intent.scope.tenantId !== job.tenantId || !same(intent.scope, acceptance.scope) ||
    acceptance.requestSha256 !== canonicalJsonSha256(intent) || source?.tenantId !== job.tenantId || source.initiatingActorId !== intent.scope.ownerActorId ||
    !principal || source.workspaceId !== intent.scope.workspaceId || source.projectId || source.missionId || source.delegationId || source.contextGrantIds.length || source.capabilityGrantIds.length) fail("Native job authority differs from its immutable acceptance.");
  const manifestValue = persistedManifestSchema.parse(rows[0].source_manifest);
  if (canonicalJsonSha256(manifestValue.consentSnapshot) !== intent.request.review.consentSha256 ||
    canonicalJsonSha256(manifestValue.sourceLinkSnapshot) !== intent.request.review.sourceLinkSha256 ||
    canonicalJsonSha256({ tenantId: intent.scope.tenantId, ownerActorId: intent.scope.ownerActorId, id: intent.scope.recordingId, ...manifestValue.recordingPolicy }) !== manifestValue.recordingAuthoritySha256 ||
    sha256Json(manifestValue.segments.map(({ id: segmentId, segmentIndex, audioSha256, byteCount, durationMs }) => ({ id: segmentId, segmentIndex, audioSha256, byteCount, durationMs }))) !== acceptance.sourceAudioManifestSha256 ||
    canonicalJsonSha256(manifestValue.segments.map((segment) => [segment.id, segment.cachedTranscriptSha256])) !== intent.request.review.transcriptCheckpointSha256) fail("Stored native source policy differs from its reviewed pin.");
  return { intent, acceptance, manifest: manifestValue, executionScope: deriveExecutionScope(source, {
    executingPrincipalType: "system", executingPrincipalId: "background-operations-worker", causationId: job.id, purpose: "capture.media.recording.process.background" }) };
}
export type NativeMeetingRecordingJob = Awaited<ReturnType<typeof loadNativeMeetingRecordingJob>>;
export async function checkNativeMeetingRecordingJob(sql: Sql, accepted: NativeMeetingRecordingJob, job: OperationJobRecord, lock = true) {
  const scope = accepted.intent.scope, value = await current(sql, scope, true, lock), source = manifest(value.recording);
  const leases = await sql`SELECT id FROM omni_operation_jobs WHERE tenant_id=${scope.tenantId} AND id=${job.id} AND status='running'
    AND lease_owner=${job.leaseOwner ?? ""} AND lease_expires_at>clock_timestamp()`;
  if (leases.length !== 1 || value.head?.operationJobId !== accepted.acceptance.operationJobId ||
    source.recordingAuthoritySha256 !== accepted.manifest.recordingAuthoritySha256 || captureRecordingAudioManifestSha256(value.recording) !== accepted.acceptance.sourceAudioManifestSha256 ||
    value.recording.segments.some((segment) => segment.rawAudioDeletedAt) || value.head.rawAudioDeletedAt ||
    canonicalJsonSha256(value.link) !== accepted.intent.request.review.sourceLinkSha256 || canonicalJsonSha256(consent(value.meeting)) !== accepted.intent.request.review.consentSha256 ||
    value.meeting.participants.some((person) => !["granted", "not_required"].includes(person.recordingConsent))) fail("Current recording consent, source or job authority changed.", "meeting_recording_authority_changed");
  return value;
}
export async function claimNativeMeetingRecordingEffect(accepted: NativeMeetingRecordingJob, job: OperationJobRecord, stage: string, request: unknown) {
  return withNativeMeetingRecordingTransaction(accepted.intent.scope, async (sql) => {
    await checkNativeMeetingRecordingJob(sql, accepted, job);
    const rows = await sql`SELECT * FROM omni_meeting_recording_processing_effects WHERE acceptance_id=${accepted.acceptance.id} AND stage=${stage} FOR UPDATE`;
    const requestSha256 = canonicalJsonSha256(request);
    if (rows.length) {
      if (rows[0].request_sha256 !== requestSha256 || rows[0].job_id !== job.id) fail("Native effect was bound to another exact input.");
      if (rows[0].state === "committed") return { committed: true as const, checkpoint: rows[0].checkpoint as Record<string, unknown>, claimId: String(rows[0].claim_id) };
      fail("A prior provider effect is unconfirmed and cannot run again.", "meeting_recording_reconciliation_required");
    }
    const claimId = randomUUID(), now = new Date().toISOString(), scope = accepted.intent.scope;
    await sql`INSERT INTO omni_meeting_recording_processing_effects(acceptance_id,tenant_id,owner_actor_id,stage,job_id,claim_id,request_sha256,state,started_at,updated_at)
      VALUES(${accepted.acceptance.id},${scope.tenantId},${scope.ownerActorId},${stage},${job.id},${claimId},${requestSha256},'started',${now},${now})`;
    return { committed: false as const, checkpoint: null, claimId };
  });
}
export async function commitNativeMeetingRecordingEffect(sql: Sql, accepted: NativeMeetingRecordingJob, job: OperationJobRecord, stage: string, claimId: string, checkpoint: Record<string, unknown>) {
  await checkNativeMeetingRecordingJob(sql, accepted, job);
  const rows = await sql`UPDATE omni_meeting_recording_processing_effects SET state='committed',checkpoint=${checkpoint}::JSONB,updated_at=clock_timestamp()
    WHERE acceptance_id=${accepted.acceptance.id} AND stage=${stage} AND job_id=${job.id} AND claim_id=${claimId} AND state='started' RETURNING stage`;
  if (rows.length !== 1) fail("Exact native effect checkpoint could not be committed.");
}
export async function holdNativeMeetingRecordingEffect(accepted: NativeMeetingRecordingJob, job: OperationJobRecord, stage: string, claimId: string, blocked = false) {
  return withNativeMeetingRecordingTransaction(accepted.intent.scope, async (sql) => {
    await sql`UPDATE omni_meeting_recording_processing_effects SET state=${blocked ? "blocked" : "unconfirmed"},updated_at=clock_timestamp()
      WHERE acceptance_id=${accepted.acceptance.id} AND stage=${stage} AND job_id=${job.id} AND claim_id=${claimId} AND state='started'`;
  });
}
