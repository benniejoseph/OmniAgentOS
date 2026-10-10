import { getSql } from "@/lib/db/client";
import { getOwnedProject } from "@/lib/projects/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { getOperationJob } from "@/lib/operations/job-queue";
import { createCaptureRecording, getCaptureRecording, prepareCaptureRecordingMediaProcessing, saveCaptureSegment } from "./recordings";
import { getCaptureMediaHead, queueCaptureMediaProcessing } from "./media-store";
import { enqueueCaptureMediaProcessingJob } from "./media-jobs";
import { listenStartSchema, LISTEN_PROCESSING_TERMS, ListenError, type ListenStart } from "./listen-contracts";
import { listenDigest, requireListenDatabase, type ListenAuthority } from "./listen-grants";
import type { CaptureRecordingDetail } from "./types";

function scope(authority: ListenAuthority, sourceId: string, action: string) {
  return executionScopeFromSecurityContext(authority.context, { purpose: `listen.${action}`,
    correlationId: `listen:${sourceId}`, capabilityGrantIds: [authority.grantId] });
}

export async function startListenRecording(authority: ListenAuthority, input: ListenStart) {
  const context = authority.context;
  if (new Date(input.recordedAt).getTime() > Date.now() + 300000) throw new ListenError(400, "listen_date_invalid", "The recording date is in the future.");
  if (input.projectId && !await getOwnedProject(input.projectId, { ...context,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context) })) {
    throw new ListenError(404, "listen_client_unavailable", "This client is no longer available. Choose where to save this conversation.");
  }
  const sourceHash = listenDigest(`${input.sourceKind}:${input.sourceKey}`);
  // Keep the original validated metadata for every retry; callers cannot rename or re-scope an already accepted source.
  await getSql()`INSERT INTO omni_listen_sources (tenant_id, actor_id, source_key_sha256, source_kind, start_payload, client_context_status)
    VALUES (${context.tenantId}, ${context.actorId}, ${sourceHash}, ${input.sourceKind}, ${input}::jsonb, ${input.projectId ? "pending" : "not_requested"})
    ON CONFLICT (tenant_id, actor_id, source_key_sha256) DO NOTHING`;
  const [source] = await getSql()`SELECT * FROM omni_listen_sources WHERE tenant_id = ${context.tenantId}
    AND actor_id = ${context.actorId} AND source_key_sha256 = ${sourceHash} LIMIT 1`;
  if (!source || source.tombstoned_at) throw deleted();
  if (source.recording_id) {
    const existing = await requireOwnedListenRecording(context, String(source.recording_id));
    return statusForRecording(context, existing);
  }
  const accepted = listenStartSchema.parse(source.start_payload);
  // The root correlation is stable across grant renewals and transport retries.
  const executionScope = scope(authority, sourceHash, "start");
  const binding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!binding || !context.auth) throw new ListenError(403, "listen_identity_required", "Your conversation identity could not be verified. Sign in again.");
  const recording = await createCaptureRecording({ ...context, executionScope, title: accepted.title,
    tags: [accepted.sourceKind === "call" ? "Phone call" : "Conversation", accepted.contextCategory],
    metadata: { listen: true, sourceKind: accepted.sourceKind, listenSourceKeySha256: sourceHash,
      recordedAt: new Date(accepted.recordedAt).toISOString(), timeZone: accepted.timeZone,
      contextCategory: accepted.contextCategory, ...(accepted.projectId ? { projectId: accepted.projectId } : {}),
      listenCanonicalActorId: binding.canonicalActorId, listenAuthUserId: context.auth.userId,
      processingTerms: LISTEN_PROCESSING_TERMS, sourceInstructionsTrusted: false } });
  const saved = await getSql()`UPDATE omni_listen_sources SET recording_id = ${recording.id}
    WHERE tenant_id = ${context.tenantId} AND actor_id = ${context.actorId} AND source_key_sha256 = ${sourceHash}
      AND tombstoned_at IS NULL AND (recording_id IS NULL OR recording_id = ${recording.id}) RETURNING recording_id`;
  if (!saved.length) throw deleted();
  return { recordingId: recording.id, status: recording.status, error: null, receivedSegments: recording.segmentCount };
}

export async function appendListenSegment(authority: ListenAuthority, input: {
  recordingId: string; segmentIndex: number; durationMs: number; sha256: string; mimeType: string; audio: Uint8Array;
}) {
  const recording = await requireOwnedListenRecording(authority.context, input.recordingId);
  if (listenDigest(input.audio) !== input.sha256) throw new ListenError(400, "listen_checksum_mismatch", "The recording chunk did not arrive intact. Please try syncing again.");
  const existing = recording.segments.find(segment => segment.segmentIndex === input.segmentIndex);
  if (existing) {
    if (existing.audioSha256 !== input.sha256 || existing.durationMs !== input.durationMs) {
      throw new ListenError(409, "listen_chunk_conflict", "This position already contains a different recording chunk.");
    }
    return { ...await statusForRecording(authority.context, recording), duplicate: true };
  }
  if (recording.status !== "recording") throw new ListenError(409, "listen_recording_closed", "This conversation has already been sent for processing.");
  await saveCaptureSegment({ ...authority.context, ...input,
    executionScope: scope(authority, recording.id, "segment"), metadata: { listen: true } });
  return { recordingId: recording.id, status: recording.status, error: null, receivedSegments: recording.segmentCount + 1, duplicate: false };
}

export async function completeListenRecording(authority: ListenAuthority, recordingId: string, segmentCount: number) {
  const context = authority.context;
  const original = await requireOwnedListenRecording(context, recordingId);
  if (original.segments.length !== segmentCount || original.segments.some((segment, index) => segment.segmentIndex !== index)) {
    throw new ListenError(409, "listen_chunks_missing", "Some recording chunks are still waiting to sync.");
  }
  const head = await getCaptureMediaHead(recordingId, context);
  if (head) return statusForRecording(context, original);
  const executionScope = scope(authority, recordingId, "complete");
  const recording = await prepareCaptureRecordingMediaProcessing(recordingId, { ...context, executionScope });
  const processing = { schemaVersion: 1 as const, recordingId, languageHints: [] as string[], speakerMappings: [],
    rawAudioRetention: { mode: "delete_after_processing" as const } };
  const job = await enqueueCaptureMediaProcessingJob({ ...context, recording, request: processing, executionScope });
  await queueCaptureMediaProcessing({ ...context, executionScope, request: processing, operationJobId: job.id });
  return { recordingId, status: "processing" as const, error: null, receivedSegments: recording.segmentCount };
}

export async function listenRecordingStatus(context: SecurityContext, recordingId: string) {
  return statusForRecording(context, await requireOwnedListenRecording(context, recordingId));
}

async function statusForRecording(context: SecurityContext, recording: CaptureRecordingDetail) {
  const head = await getCaptureMediaHead(recording.id, context);
  const job = head ? await getOperationJob(head.operationJobId, context) : null;
  const failed = recording.status === "failed" || head?.processingStatus === "failed" || job?.status === "failed";
  return { recordingId: recording.id, status: failed ? "failed" as const : recording.status,
    error: failed ? listenProcessingMessage(recording.metadata.ingestError) : null,
    receivedSegments: recording.segmentCount };
}

export async function listListenConversations(context: SecurityContext) {
  await requireListenDatabase();
  // A history refresh must never load complete transcripts or audio manifests.
  const rows = await getSql()`SELECT r.id, r.title, r.status, r.duration_ms, r.created_at,
      r.metadata ->> 'recordedAt' AS recorded_at, r.metadata ->> 'sourceKind' AS source_kind,
      r.metadata ->> 'contextCategory' AS context_category, r.metadata ->> 'projectId' AS project_id,
      r.metadata ->> 'ingestError' AS processing_error,
      left(h.output_snapshot -> 'summary' ->> 'text', 600) AS summary,
      jsonb_array_length(COALESCE(h.output_snapshot -> 'actionItems', '[]'::jsonb)) AS action_count,
      h.processing_status, j.status AS processing_job_status
    FROM omni_listen_sources s
    JOIN omni_capture_recordings r ON r.id = s.recording_id AND r.tenant_id = s.tenant_id AND r.actor_id = s.actor_id
    LEFT JOIN omni_capture_media_heads h ON h.recording_id = r.id AND h.tenant_id = r.tenant_id AND h.owner_actor_id = r.actor_id
    LEFT JOIN omni_operation_jobs j ON j.id = h.operation_job_id AND j.tenant_id = h.tenant_id
    WHERE s.tenant_id = ${context.tenantId} AND s.actor_id = ${context.actorId} AND s.tombstoned_at IS NULL
    ORDER BY r.metadata ->> 'recordedAt' DESC, r.created_at DESC LIMIT 50`;
  return { conversations: rows.map(row => {
    const failed = row.status === "failed" || row.processing_status === "failed" || row.processing_job_status === "failed";
    return { id: String(row.id), title: String(row.title), sourceKind: row.source_kind === "call" ? "call" : "listen",
      recordedAt: new Date(String(row.recorded_at || row.created_at)).toISOString(), createdAt: new Date(String(row.created_at)).toISOString(),
      status: failed ? "failed" : String(row.status), durationMs: Number(row.duration_ms), summary: String(row.summary || ""),
      category: row.context_category === "work" ? "work" : row.context_category === "personal" ? "personal" : "unfiled",
      projectId: row.project_id ? String(row.project_id) : null, actionCount: Number(row.action_count || 0),
      error: failed ? listenProcessingMessage(row.processing_error) : null };
  }) };
}

function listenProcessingMessage(value: unknown): string {
  const noSpeech = "No clear speech was detected in this conversation. No notes or memories were created. Your recording has been kept.";
  if (value === noSpeech) return noSpeech;
  if (typeof value === "string") {
    const part = /^Part ([1-9]\d{0,3}) could not be transcribed after several attempts\. Check the transcription service in Settings\. Your recording has been kept\.$/.exec(value);
    if (part && Number(part[1]) <= 1_440) {
      return `Part ${Number(part[1])} could not be transcribed after several attempts. Check the transcription service in Settings. Your recording has been kept.`;
    }
  }
  // Provider messages may contain credential or transport details. Publish only
  // these fixed application messages, never a raw ingestion error.
  return "Processing stopped. Your recording is saved; open this conversation to review it.";
}

export async function readListenConversation(context: SecurityContext, recordingId: string) {
  await requireListenDatabase();
  const recording = await requireOwnedListenRecording(context, recordingId);
  const media = await getCaptureMediaHead(recordingId, context);
  const [source] = await getSql()`SELECT client_context_status FROM omni_listen_sources
    WHERE tenant_id = ${context.tenantId} AND actor_id = ${context.actorId} AND recording_id = ${recordingId} LIMIT 1`;
  const clientStatus = String(source?.client_context_status || "not_requested");
  return { conversation: { ...await conversationSummary(context, recording), transcript: recording.transcript,
    media: media?.output ?? null, clientContext: { status: clientStatus,
      message: clientStatus === "linked" ? "Added to the selected client's context." : clientStatus === "pending" ? "This conversation will join the selected client's context after processing." :
        clientStatus === "needs_attention" ? "Your conversation is saved. Its client link needs attention; add the transcript from Work when the client is available." : "Saved in your private conversations." } } };
}

async function conversationSummary(context: SecurityContext, recording: CaptureRecordingDetail) {
  const media = await getCaptureMediaHead(recording.id, context);
  const state = await statusForRecording(context, recording);
  return { id: recording.id, title: recording.title, sourceKind: recording.metadata.sourceKind === "call" ? "call" as const : "listen" as const,
    recordedAt: String(recording.metadata.recordedAt || recording.startedAt), createdAt: recording.createdAt,
    status: state.status, durationMs: recording.durationMs, summary: media?.output?.summary.text || "",
    category: recording.metadata.contextCategory === "work" ? "work" as const : recording.metadata.contextCategory === "personal" ? "personal" as const : "unfiled" as const,
    projectId: projectOf(recording) || null, actionCount: media?.output?.actionItems.length || 0, error: state.error };
}

async function requireOwnedListenRecording(context: SecurityContext, recordingId: string) {
  const [source] = await getSql()`SELECT tombstoned_at FROM omni_listen_sources WHERE tenant_id = ${context.tenantId}
    AND actor_id = ${context.actorId} AND recording_id = ${recordingId} LIMIT 1`;
  if (!source) throw new ListenError(404, "listen_recording_unavailable", "This conversation is not available.");
  if (source.tombstoned_at) throw deleted();
  const recording = await getCaptureRecording(recordingId, context);
  if (!recording || recording.metadata.listen !== true) throw deleted();
  return recording;
}
function projectOf(recording: CaptureRecordingDetail) { return typeof recording.metadata.projectId === "string" ? recording.metadata.projectId : undefined; }
function deleted() { return new ListenError(410, "listen_source_deleted", "This recording was deleted and will not be imported again."); }
