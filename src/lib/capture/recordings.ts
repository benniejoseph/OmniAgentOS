import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureActorReadOrder } from "@/lib/capture/actor-scope";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import {
  assertExecutionScopeTenant,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import type {
  CaptureRecording,
  CaptureRecordingDetail,
  CaptureRecordingStatus,
  CaptureSegment,
  CaptureTranscriptionStatus,
  RequestCaptureRecordingSummary,
} from "@/lib/capture/types";

export const MAX_CAPTURE_SEGMENT_BYTES = 3 * 1024 * 1024;
export const MAX_CAPTURE_SEGMENTS = 1_440;
export const MAX_CAPTURE_RECORDING_BYTES = 1024 * 1024 * 1024;
export const MAX_CAPTURE_RECORDING_DURATION_MS = 24 * 60 * 60 * 1_000;

type CaptureLedger = {
  recordings: CaptureRecording[];
  segments: Array<CaptureSegment & { audioPath: string }>;
};

type Owner = { tenantId: string; actorId: string };
type CaptureRecordingListOwner = Owner & {
  requestActorBinding?: CanonicalRequestActorBindingV1;
};
type ScopedOwner = Owner & { executionScope: ExecutionScope };
type CaptureRecordingPhysicalSummary = Omit<
  RequestCaptureRecordingSummary,
  "detailAvailable" | "manageable"
> & {
  tenantId: string;
  actorId: string;
};
type CaptureRecordingEventPayload = {
  schemaVersion: 1;
  recordingId: string;
  status?: CaptureRecordingStatus;
  previousStatus?: CaptureRecordingStatus;
  byteCount?: number;
  segmentCount?: number;
  transcriptSha256?: string;
  transcriptByteCount?: number;
  detailsSha256?: string;
  ingestJobId?: string;
  knowledgeDocumentId?: string;
  errorSha256?: string;
  errorByteCount?: number;
  scopeVersion?: ExecutionScope["version"];
  scopeSha256?: string;
};
type CaptureSegmentEventPayload = {
  schemaVersion: 1;
  segmentId: string;
  recordingId: string;
  segmentIndex: number;
  audioSha256?: string;
  byteCount?: number;
  transcriptionStatus?: CaptureTranscriptionStatus;
  previousTranscriptionStatus?: CaptureTranscriptionStatus;
  transcriptSha256?: string;
  transcriptByteCount?: number;
  modelSha256?: string;
  errorSha256?: string;
  errorByteCount?: number;
  scopeVersion?: ExecutionScope["version"];
  scopeSha256?: string;
};

const CAPTURE_EVENT_SCHEMA_VERSION = 1 as const;

export class CaptureRecordingError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 413 = 400,
    public readonly code = "capture_recording_error",
  ) {
    super(message);
    this.name = "CaptureRecordingError";
  }
}

export class CaptureRecordingReadConflictError extends Error {
  constructor(message = "Capture recording ownership is ambiguous.") {
    super(message);
    this.name = "CaptureRecordingReadConflictError";
  }
}

export async function createCaptureRecording(input: ScopedOwner & {
  title?: string;
  language?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}) {
  const executionScope = requireCaptureRecordingMutationScope(input);
  const now = new Date().toISOString();
  const id = randomUUID();
  const recording: CaptureRecording = {
    id,
    tenantId: normalizeTenantId(input.tenantId),
    actorId: normalizeActorId(input.actorId),
    title: safeTitle(input.title || `Conversation ${formatCaptureDate(now)}`),
    status: "recording",
    language: normalizeLanguage(input.language),
    tags: normalizeTags(input.tags || []),
    startedAt: now,
    durationMs: 0,
    byteCount: 0,
    segmentCount: 0,
    transcript: "",
    source: `capture:recording:${id}`,
    metadata: sanitizeMetadata(input.metadata),
    createdAt: now,
    updatedAt: now,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
        INSERT INTO omni_capture_recordings (
          id, tenant_id, actor_id, title, status, language, tags, started_at,
          duration_ms, byte_count, segment_count, transcript, source, metadata,
          created_at, updated_at
        ) VALUES (
          ${recording.id}, ${recording.tenantId}, ${recording.actorId},
          ${recording.title}, ${recording.status}, ${recording.language},
          ${recording.tags}, ${recording.startedAt}, ${recording.durationMs},
          ${recording.byteCount}, ${recording.segmentCount}, ${recording.transcript},
          ${recording.source}, ${recording.metadata}::jsonb, ${recording.createdAt},
          ${recording.updatedAt}
        )
        RETURNING *
      `;
      const saved = recordingFromRow(rows[0]);
      await appendCaptureRecordingEvent(saved.id, executionScope, "capture_recording.scope_bound", {
        schemaVersion: CAPTURE_EVENT_SCHEMA_VERSION,
        recordingId: saved.id,
        status: saved.status,
        byteCount: saved.byteCount,
        segmentCount: saved.segmentCount,
        detailsSha256: captureRecordingDetailsSha256(saved),
        scopeVersion: executionScope.version,
        scopeSha256: sha256Json(executionScope),
      }, { sql });
      return saved;
    }) as Promise<CaptureRecording>;
  }

  await updateJsonFile<CaptureLedger>(getCaptureLedgerFile(), emptyLedger(), (ledger) => ({
    recordings: [recording, ...ledger.recordings],
    segments: ledger.segments,
  }));
  await appendCaptureRecordingEvent(recording.id, executionScope, "capture_recording.scope_bound", {
    schemaVersion: CAPTURE_EVENT_SCHEMA_VERSION,
    recordingId: recording.id,
    status: recording.status,
    byteCount: recording.byteCount,
    segmentCount: recording.segmentCount,
    detailsSha256: captureRecordingDetailsSha256(recording),
    scopeVersion: executionScope.version,
    scopeSha256: sha256Json(executionScope),
  });
  return recording;
}

export async function listCaptureRecordings(owner: Owner, limit = 50) {
  const tenantId = normalizeTenantId(owner.tenantId);
  const actorId = normalizeActorId(owner.actorId);
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT id, tenant_id, actor_id, title, status, language, tags, started_at,
        completed_at, duration_ms, byte_count, segment_count,
        LEFT(transcript, 4000) AS transcript, source, knowledge_document_id,
        ingest_job_id, metadata, created_at, updated_at
      FROM omni_capture_recordings
      WHERE tenant_id = ${tenantId} AND actor_id = ${actorId}
      ORDER BY updated_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(recordingFromRow);
  }
  const ledger = await readCaptureLedger();
  return ledger.recordings
    .filter((item) => item.tenantId === tenantId && item.actorId === actorId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, boundedLimit)
    .map((item) => ({ ...item, transcript: item.transcript.slice(0, 4_000) }));
}

/**
 * Returns a request-safe recording catalog. The compatibility owner may expose
 * only summary metadata; transcripts, audio, linked knowledge, and mutations
 * remain exact-owner operations through their existing routes.
 */
export async function listCaptureRecordingsForRequest(
  owner: CaptureRecordingListOwner,
  limit = 50,
): Promise<RequestCaptureRecordingSummary[]> {
  const tenantId = normalizeTenantId(owner.tenantId);
  const requestActorId = normalizeActorId(owner.actorId);
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 100);
  if (!hasDatabaseUrl()) {
    const ledger = await readCaptureLedger();
    const summaries = ledger.recordings
      .filter((item) =>
        item.tenantId === tenantId && item.actorId === requestActorId
      )
      .map(recordingSummaryFromRecording);
    assertRequestCaptureRecordingSummaries(
      summaries,
      tenantId,
      requestActorId,
      requestActorId,
    );
    return summaries
      .sort(compareCaptureRecordingSummaries)
      .slice(0, boundedLimit)
      .map((summary) =>
        requestCaptureRecordingSummary(summary, requestActorId)
      );
  }

  const [canonicalActorId, exactActorId] = captureActorReadOrder(
    owner.actorId,
    owner.requestActorBinding,
    requestActorId,
  );
  await ensureDatabaseSchema();
  const rows = await getSql()`
    WITH canonical_rows AS (
      SELECT id, tenant_id, actor_id, title, status, started_at, completed_at,
        duration_ms, segment_count, updated_at
      FROM omni_capture_recordings
      WHERE tenant_id = ${tenantId}
        AND actor_id = ${canonicalActorId}
        AND tenant_id COLLATE "C" = ${tenantId}::text COLLATE "C"
        AND actor_id COLLATE "C" = ${canonicalActorId}::text COLLATE "C"
      ORDER BY updated_at DESC, id COLLATE "C" ASC
      LIMIT ${boundedLimit}
    ), exact_rows AS (
      SELECT id, tenant_id, actor_id, title, status, started_at, completed_at,
        duration_ms, segment_count, updated_at
      FROM omni_capture_recordings
      WHERE ${exactActorId}::text COLLATE "C" <>
          ${canonicalActorId}::text COLLATE "C"
        AND tenant_id = ${tenantId}
        AND actor_id = ${exactActorId}
        AND tenant_id COLLATE "C" = ${tenantId}::text COLLATE "C"
        AND actor_id COLLATE "C" = ${exactActorId}::text COLLATE "C"
      ORDER BY updated_at DESC, id COLLATE "C" ASC
      LIMIT ${boundedLimit}
    ), readable AS (
      SELECT * FROM canonical_rows
      UNION ALL
      SELECT * FROM exact_rows
    )
    SELECT id, tenant_id, actor_id, title, status, started_at, completed_at,
      duration_ms, segment_count, updated_at
    FROM readable
    ORDER BY updated_at DESC, id COLLATE "C" ASC
    LIMIT ${boundedLimit}
  `;
  const summaries = rows.map(recordingSummaryFromRow);
  assertRequestCaptureRecordingSummaries(
    summaries,
    tenantId,
    canonicalActorId,
    exactActorId,
  );
  return summaries.map((summary) =>
    requestCaptureRecordingSummary(summary, exactActorId)
  );
}

export async function getCaptureRecording(id: string, owner: Owner): Promise<CaptureRecordingDetail | undefined> {
  const tenantId = normalizeTenantId(owner.tenantId);
  const actorId = normalizeActorId(owner.actorId);
  const recordingId = normalizeId(id);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const [recordingRows, segmentRows] = await Promise.all([
      getSql()`SELECT * FROM omni_capture_recordings WHERE id = ${recordingId} AND tenant_id = ${tenantId} AND actor_id = ${actorId} LIMIT 1`,
      getSql()`SELECT id, tenant_id, actor_id, recording_id, segment_index, mime_type, byte_count, duration_ms, audio_sha256, transcript, transcription_status, transcription_model, transcription_error, metadata, created_at, updated_at FROM omni_capture_segments WHERE recording_id = ${recordingId} AND tenant_id = ${tenantId} AND actor_id = ${actorId} ORDER BY segment_index ASC`,
    ]);
    if (!recordingRows[0]) return undefined;
    return { ...recordingFromRow(recordingRows[0]), segments: segmentRows.map(segmentFromRow) };
  }
  const ledger = await readCaptureLedger();
  const recording = ledger.recordings.find((item) => item.id === recordingId && item.tenantId === tenantId && item.actorId === actorId);
  if (!recording) return undefined;
  return {
    ...recording,
    segments: ledger.segments
      .filter((item) => item.recordingId === recordingId && item.tenantId === tenantId && item.actorId === actorId)
      .sort((left, right) => left.segmentIndex - right.segmentIndex)
      .map(withoutAudioPath),
  };
}

/** Trusted compatibility lookup for Capture jobs queued before actor metadata moved out of the request body. */
export async function resolveCaptureRecordingActorForIngestJob(
  id: string,
  input: { tenantId: string; ingestJobId: string },
) {
  const tenantId = normalizeTenantId(input.tenantId);
  const recordingId = normalizeId(id);
  const ingestJobId = normalizeId(input.ingestJobId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT actor_id
      FROM omni_capture_recordings
      WHERE id = ${recordingId}
        AND tenant_id = ${tenantId}
        AND ingest_job_id = ${ingestJobId}
      LIMIT 1
    `;
    return rows[0]?.actor_id ? normalizeActorId(String(rows[0].actor_id)) : undefined;
  }
  const ledger = await readCaptureLedger();
  const recording = ledger.recordings.find((item) =>
    item.id === recordingId &&
    item.tenantId === tenantId &&
    item.ingestJobId === ingestJobId
  );
  return recording?.actorId;
}

export async function updateCaptureRecording(id: string, owner: ScopedOwner, input: {
  title?: string;
  tags?: string[];
  language?: string;
}) {
  const executionScope = requireCaptureRecordingMutationScope(owner);
  const current = await requireCaptureRecording(id, owner);
  const updatedAt = new Date().toISOString();
  const next = {
    ...current,
    title: input.title === undefined ? current.title : safeTitle(input.title),
    tags: input.tags === undefined ? current.tags : normalizeTags(input.tags),
    language: input.language === undefined ? current.language : normalizeLanguage(input.language),
    updatedAt,
  };
  if (hasDatabaseUrl()) {
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
        UPDATE omni_capture_recordings
        SET title = ${next.title}, tags = ${next.tags}, language = ${next.language}, updated_at = ${updatedAt}
        WHERE id = ${current.id} AND tenant_id = ${current.tenantId} AND actor_id = ${current.actorId}
        RETURNING *
      `;
      const updated = recordingFromRow(rows[0]);
      await appendCaptureRecordingDetailsEvent(updated, executionScope, { sql });
      return updated;
    }) as Promise<CaptureRecording>;
  }
  await updateJsonFile<CaptureLedger>(getCaptureLedgerFile(), emptyLedger(), (ledger) => ({
    ...ledger,
    recordings: ledger.recordings.map((item) => item.id === current.id && item.tenantId === current.tenantId && item.actorId === current.actorId ? stripSegments(next) : item),
  }));
  await appendCaptureRecordingDetailsEvent(stripSegments(next), executionScope);
  return stripSegments(next);
}

export async function saveCaptureSegment(input: ScopedOwner & {
  recordingId: string;
  segmentIndex: number;
  mimeType: string;
  audio: Uint8Array;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}) {
  const executionScope = requireCaptureRecordingMutationScope(input);
  const recording = await requireCaptureRecording(input.recordingId, input);
  if (recording.status !== "recording") {
    throw new CaptureRecordingError("This recording is already being finalized.", 409, "recording_closed");
  }
  if (!Number.isInteger(input.segmentIndex) || input.segmentIndex < 0 || input.segmentIndex >= MAX_CAPTURE_SEGMENTS) {
    throw new CaptureRecordingError(`Segment index must be between 0 and ${MAX_CAPTURE_SEGMENTS - 1}.`);
  }
  if (!input.audio.byteLength || input.audio.byteLength > MAX_CAPTURE_SEGMENT_BYTES) {
    throw new CaptureRecordingError("Each recording segment must be 3 MB or smaller.", 413, "segment_too_large");
  }
  const durationMs = Math.min(Math.max(Math.round(input.durationMs || 0), 0), 10 * 60 * 1_000);
  if (recording.byteCount + input.audio.byteLength > MAX_CAPTURE_RECORDING_BYTES || recording.durationMs + durationMs > MAX_CAPTURE_RECORDING_DURATION_MS) {
    throw new CaptureRecordingError("This recording reached the 24 hour or 1 GB storage limit.", 413, "recording_limit_reached");
  }
  const now = new Date().toISOString();
  const hash = createHash("sha256").update(input.audio).digest("hex");
  const segment: CaptureSegment = {
    id: randomUUID(),
    tenantId: recording.tenantId,
    actorId: recording.actorId,
    recordingId: recording.id,
    segmentIndex: input.segmentIndex,
    mimeType: normalizeMimeType(input.mimeType),
    byteCount: input.audio.byteLength,
    durationMs,
    audioSha256: hash,
    transcript: "",
    transcriptionStatus: "pending",
    metadata: sanitizeMetadata(input.metadata),
    createdAt: now,
    updatedAt: now,
  };

  if (hasDatabaseUrl()) {
    const result = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const inserted = await sql`
        INSERT INTO omni_capture_segments (
          id, tenant_id, actor_id, recording_id, segment_index, mime_type,
          byte_count, duration_ms, audio_sha256, audio_data, transcript,
          transcription_status, metadata, created_at, updated_at
        ) VALUES (
          ${segment.id}, ${segment.tenantId}, ${segment.actorId}, ${segment.recordingId},
          ${segment.segmentIndex}, ${segment.mimeType}, ${segment.byteCount},
          ${segment.durationMs}, ${segment.audioSha256}, ${Buffer.from(input.audio)},
          '', 'pending', ${segment.metadata}::jsonb, ${now}, ${now}
        )
        ON CONFLICT (tenant_id, recording_id, segment_index) DO NOTHING
        RETURNING id, tenant_id, actor_id, recording_id, segment_index, mime_type,
          byte_count, duration_ms, audio_sha256, transcript, transcription_status,
          transcription_model, transcription_error, metadata, created_at, updated_at
      `;
      if (!inserted[0]) {
        const existing = await sql`
          SELECT id, tenant_id, actor_id, recording_id, segment_index, mime_type,
            byte_count, duration_ms, audio_sha256, transcript, transcription_status,
            transcription_model, transcription_error, metadata, created_at, updated_at
          FROM omni_capture_segments
          WHERE tenant_id = ${segment.tenantId} AND actor_id = ${segment.actorId}
            AND recording_id = ${segment.recordingId} AND segment_index = ${segment.segmentIndex}
          LIMIT 1
        `;
        if (!existing[0] || String(existing[0].audio_sha256) !== hash) {
          throw new CaptureRecordingError("A different audio segment already uses this position.", 409, "segment_conflict");
        }
        return { segment: segmentFromRow(existing[0]), created: false };
      }
      const updated = await sql`
        UPDATE omni_capture_recordings
        SET byte_count = byte_count + ${segment.byteCount},
            duration_ms = duration_ms + ${segment.durationMs},
            segment_count = segment_count + 1,
            updated_at = ${now}
        WHERE id = ${segment.recordingId} AND tenant_id = ${segment.tenantId}
          AND actor_id = ${segment.actorId} AND status = 'recording'
          AND byte_count + ${segment.byteCount} <= ${MAX_CAPTURE_RECORDING_BYTES}
          AND duration_ms + ${segment.durationMs} <= ${MAX_CAPTURE_RECORDING_DURATION_MS}
        RETURNING id
      `;
      if (!updated[0]) {
        throw new CaptureRecordingError("This recording is closed or reached its storage limit.", 409, "recording_closed");
      }
      const saved = segmentFromRow(inserted[0]);
      await appendCaptureSegmentEvent(saved, executionScope, "capture_segment.scope_bound", {
        schemaVersion: CAPTURE_EVENT_SCHEMA_VERSION,
        segmentId: saved.id,
        recordingId: saved.recordingId,
        segmentIndex: saved.segmentIndex,
        audioSha256: saved.audioSha256,
        byteCount: saved.byteCount,
        transcriptionStatus: saved.transcriptionStatus,
        scopeVersion: executionScope.version,
        scopeSha256: sha256Json(executionScope),
      }, { sql });
      return { segment: saved, created: true };
    });
    return result as { segment: CaptureSegment; created: boolean };
  }

  const directory = getCaptureAudioDirectory(recording.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const audioPath = path.join(directory, `${segment.id}.bin`);
  await writeFile(audioPath, input.audio, { mode: 0o600 });
  let result: { segment: CaptureSegment; created: boolean } = { segment, created: true };
  await updateJsonFile<CaptureLedger>(getCaptureLedgerFile(), emptyLedger(), (ledger) => {
    const existing = ledger.segments.find((item) => item.recordingId === recording.id && item.segmentIndex === segment.segmentIndex && item.tenantId === recording.tenantId);
    if (existing) {
      if (existing.audioSha256 !== hash) throw new CaptureRecordingError("A different audio segment already uses this position.", 409, "segment_conflict");
      result = { segment: withoutAudioPath(existing), created: false };
      return ledger;
    }
    return {
      recordings: ledger.recordings.map((item) => item.id === recording.id && item.tenantId === recording.tenantId && item.actorId === recording.actorId ? {
        ...item,
        byteCount: item.byteCount + segment.byteCount,
        durationMs: item.durationMs + segment.durationMs,
        segmentCount: item.segmentCount + 1,
        updatedAt: now,
      } : item),
      segments: [...ledger.segments, { ...segment, audioPath }],
    };
  });
  if (!result.created) await rm(audioPath, { force: true }).catch(() => undefined);
  if (result.created) {
    await appendCaptureSegmentEvent(result.segment, executionScope, "capture_segment.scope_bound", {
      schemaVersion: CAPTURE_EVENT_SCHEMA_VERSION,
      segmentId: result.segment.id,
      recordingId: result.segment.recordingId,
      segmentIndex: result.segment.segmentIndex,
      audioSha256: result.segment.audioSha256,
      byteCount: result.segment.byteCount,
      transcriptionStatus: result.segment.transcriptionStatus,
      scopeVersion: executionScope.version,
      scopeSha256: sha256Json(executionScope),
    });
  }
  return result;
}

export async function updateCaptureSegmentTranscription(input: ScopedOwner & {
  recordingId: string;
  segmentIndex: number;
  status: CaptureTranscriptionStatus;
  transcript?: string;
  model?: string;
  error?: string;
}) {
  const executionScope = requireCaptureRecordingMutationScope(input);
  const recording = await requireCaptureRecording(input.recordingId, input);
  const previous = recording.segments.find((segment) => segment.segmentIndex === input.segmentIndex);
  if (!previous) throw new CaptureRecordingError("Recording segment not found.", 404, "segment_not_found");
  const now = new Date().toISOString();
  const transcript = safeTranscript(input.transcript || "");
  const model = safeShort(input.model, 160);
  const error = safeShort(input.error, 1_000);
  if (hasDatabaseUrl()) {
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
        UPDATE omni_capture_segments
        SET transcript = ${transcript}, transcription_status = ${input.status},
            transcription_model = ${model || null}, transcription_error = ${error || null},
            updated_at = ${now}
        WHERE tenant_id = ${recording.tenantId} AND actor_id = ${recording.actorId}
          AND recording_id = ${recording.id} AND segment_index = ${input.segmentIndex}
        RETURNING id, tenant_id, actor_id, recording_id, segment_index, mime_type,
          byte_count, duration_ms, audio_sha256, transcript, transcription_status,
          transcription_model, transcription_error, metadata, created_at, updated_at
      `;
      if (!rows[0]) throw new CaptureRecordingError("Recording segment not found.", 404, "segment_not_found");
      const updated = segmentFromRow(rows[0]);
      await appendCaptureSegmentTranscriptionEvent(previous, updated, executionScope, { sql });
      return updated;
    }) as Promise<CaptureSegment>;
  }
  let updated: CaptureSegment | undefined;
  await updateJsonFile<CaptureLedger>(getCaptureLedgerFile(), emptyLedger(), (ledger) => ({
    ...ledger,
    segments: ledger.segments.map((item) => {
      if (item.recordingId !== recording.id || item.segmentIndex !== input.segmentIndex || item.actorId !== recording.actorId) return item;
      const next = { ...item, transcript, transcriptionStatus: input.status, transcriptionModel: model, transcriptionError: error, updatedAt: now };
      updated = withoutAudioPath(next);
      return next;
    }),
  }));
  if (!updated) throw new CaptureRecordingError("Recording segment not found.", 404, "segment_not_found");
  await appendCaptureSegmentTranscriptionEvent(previous, updated, executionScope);
  return updated;
}

export async function getCaptureSegmentAudio(recordingId: string, segmentIndex: number, owner: Owner) {
  const recording = await requireCaptureRecording(recordingId, owner);
  if (hasDatabaseUrl()) {
    const rows = await getSql()`
      SELECT audio_data, mime_type, byte_count, audio_sha256
      FROM omni_capture_segments
      WHERE tenant_id = ${recording.tenantId} AND actor_id = ${recording.actorId}
        AND recording_id = ${recording.id} AND segment_index = ${segmentIndex}
      LIMIT 1
    `;
    if (!rows[0]) throw new CaptureRecordingError("Recording segment not found.", 404, "segment_not_found");
    return {
      bytes: Buffer.from(rows[0].audio_data as Uint8Array),
      mimeType: String(rows[0].mime_type),
      byteCount: Number(rows[0].byte_count || 0),
      sha256: String(rows[0].audio_sha256),
    };
  }
  const ledger = await readCaptureLedger();
  const segment = ledger.segments.find((item) => item.recordingId === recording.id && item.segmentIndex === segmentIndex && item.actorId === recording.actorId);
  if (!segment) throw new CaptureRecordingError("Recording segment not found.", 404, "segment_not_found");
  return { bytes: await readFile(segment.audioPath), mimeType: segment.mimeType, byteCount: segment.byteCount, sha256: segment.audioSha256 };
}

export async function prepareCaptureRecordingCompletion(id: string, owner: ScopedOwner) {
  const executionScope = requireCaptureRecordingMutationScope(owner);
  const detail = await requireCaptureRecording(id, owner);
  if (detail.status === "ready" && detail.ingestJobId) return detail;
  const usable = detail.segments.filter((segment) => segment.transcriptionStatus === "completed" && segment.transcript.trim());
  if (!usable.length) throw new CaptureRecordingError("No transcribed speech is ready to save yet.", 409, "transcript_not_ready");
  const pending = detail.segments.filter((segment) => segment.transcriptionStatus === "pending");
  if (pending.length) throw new CaptureRecordingError("Some recording segments are still being transcribed.", 409, "transcription_pending");
  // Preserve the complete transcript with the recording. The RAG queue applies
  // its own bounded indexing window without discarding the durable source.
  const transcript = usable.map((segment) => segment.transcript.trim()).join("\n\n");
  const completedAt = new Date().toISOString();
  const status: CaptureRecordingStatus = "processing";
  if (hasDatabaseUrl()) {
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
        UPDATE omni_capture_recordings
        SET status = ${status}, transcript = ${transcript}, completed_at = ${completedAt}, updated_at = ${completedAt}
        WHERE id = ${detail.id} AND tenant_id = ${detail.tenantId} AND actor_id = ${detail.actorId}
        RETURNING *
      `;
      const updated = recordingFromRow(rows[0]);
      await appendCaptureRecordingStatusEvent(detail, updated, executionScope, undefined, { sql });
      return { ...updated, segments: detail.segments };
    }) as Promise<CaptureRecordingDetail>;
  }
  const next = { ...stripSegments(detail), status, transcript, completedAt, updatedAt: completedAt };
  await updateJsonFile<CaptureLedger>(getCaptureLedgerFile(), emptyLedger(), (ledger) => ({
    ...ledger,
    recordings: ledger.recordings.map((item) => item.id === detail.id && item.actorId === detail.actorId ? next : item),
  }));
  await appendCaptureRecordingStatusEvent(detail, next, executionScope);
  return { ...next, segments: detail.segments };
}

export async function markCaptureRecordingIngestQueued(id: string, owner: ScopedOwner, ingestJobId: string) {
  const executionScope = requireCaptureRecordingMutationScope(owner);
  const detail = await requireCaptureRecording(id, owner);
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
        UPDATE omni_capture_recordings
        SET ingest_job_id = ${ingestJobId}, status = 'processing', updated_at = ${now}
        WHERE id = ${detail.id} AND tenant_id = ${detail.tenantId} AND actor_id = ${detail.actorId}
        RETURNING *
      `;
      const updated = recordingFromRow(rows[0]);
      await appendCaptureRecordingStatusEvent(detail, updated, executionScope, undefined, { sql });
      return updated;
    }) as Promise<CaptureRecording>;
  }
  const next: CaptureRecording = { ...stripSegments(detail), ingestJobId, status: "processing", updatedAt: now };
  await updateJsonFile<CaptureLedger>(getCaptureLedgerFile(), emptyLedger(), (ledger) => ({
    ...ledger,
    recordings: ledger.recordings.map((item) => item.id === detail.id && item.actorId === detail.actorId ? next : item),
  }));
  await appendCaptureRecordingStatusEvent(detail, next, executionScope);
  return next;
}

export async function markCaptureRecordingIndexed(id: string, owner: ScopedOwner, input: {
  knowledgeDocumentId?: string;
  error?: string;
}) {
  const executionScope = requireCaptureRecordingMutationScope(owner);
  const detail = await requireCaptureRecording(id, owner);
  const now = new Date().toISOString();
  const status: CaptureRecordingStatus = input.error ? "failed" : "ready";
  const error = safeShort(input.error, 1_000);
  const metadata = { ...detail.metadata };
  if (error) metadata.ingestError = error;
  else delete metadata.ingestError;
  if (hasDatabaseUrl()) {
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
        UPDATE omni_capture_recordings
        SET status = ${status}, knowledge_document_id = ${input.knowledgeDocumentId || null},
            metadata = ${metadata}::jsonb, updated_at = ${now}
        WHERE id = ${detail.id} AND tenant_id = ${detail.tenantId} AND actor_id = ${detail.actorId}
        RETURNING *
      `;
      const updated = recordingFromRow(rows[0]);
      await appendCaptureRecordingStatusEvent(detail, updated, executionScope, error, { sql });
      return updated;
    }) as Promise<CaptureRecording>;
  }
  const next: CaptureRecording = { ...stripSegments(detail), status, knowledgeDocumentId: input.knowledgeDocumentId, metadata, updatedAt: now };
  await updateJsonFile<CaptureLedger>(getCaptureLedgerFile(), emptyLedger(), (ledger) => ({
    ...ledger,
    recordings: ledger.recordings.map((item) => item.id === detail.id && item.actorId === detail.actorId ? next : item),
  }));
  await appendCaptureRecordingStatusEvent(detail, next, executionScope, error);
  return next;
}

export async function deleteCaptureRecording(id: string, owner: ScopedOwner) {
  const executionScope = requireCaptureRecordingMutationScope(owner);
  const detail = await requireCaptureRecording(id, owner);
  if (hasDatabaseUrl()) {
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`DELETE FROM omni_capture_recordings WHERE id = ${detail.id} AND tenant_id = ${detail.tenantId} AND actor_id = ${detail.actorId} RETURNING id`;
      if (!rows[0]) return false;
      await appendCaptureRecordingEvent(detail.id, executionScope, "capture_recording.deleted", captureRecordingReferencePayload(detail, {
        previousStatus: detail.status,
      }), { sql });
      return true;
    }) as Promise<boolean>;
  }
  await updateJsonFile<CaptureLedger>(getCaptureLedgerFile(), emptyLedger(), (ledger) => ({
    recordings: ledger.recordings.filter((item) => !(item.id === detail.id && item.tenantId === detail.tenantId && item.actorId === detail.actorId)),
    segments: ledger.segments.filter((item) => !(item.recordingId === detail.id && item.tenantId === detail.tenantId && item.actorId === detail.actorId)),
  }));
  await rm(getCaptureAudioDirectory(detail.id), { recursive: true, force: true }).catch(() => undefined);
  await appendCaptureRecordingEvent(detail.id, executionScope, "capture_recording.deleted", captureRecordingReferencePayload(detail, {
    previousStatus: detail.status,
  }));
  return true;
}

async function appendCaptureRecordingDetailsEvent(
  recording: CaptureRecording,
  executionScope: ExecutionScope,
  options: { sql?: ReturnType<typeof getSql> } = {},
) {
  await appendCaptureRecordingEvent(
    recording.id,
    executionScope,
    "capture_recording.details_changed",
    captureRecordingReferencePayload(recording, {
      status: recording.status,
      detailsSha256: captureRecordingDetailsSha256(recording),
    }),
    options,
  );
}

async function appendCaptureRecordingStatusEvent(
  previous: CaptureRecording,
  next: CaptureRecording,
  executionScope: ExecutionScope,
  error?: string,
  options: { sql?: ReturnType<typeof getSql> } = {},
) {
  await appendCaptureRecordingEvent(
    next.id,
    executionScope,
    "capture_recording.status_changed",
    captureRecordingReferencePayload(next, {
      previousStatus: previous.status,
      status: next.status,
      ingestJobId: next.ingestJobId,
      knowledgeDocumentId: next.knowledgeDocumentId,
      errorSha256: error ? sha256Text(error) : undefined,
      errorByteCount: error ? Buffer.byteLength(error, "utf8") : undefined,
    }),
    options,
  );
}

function captureRecordingReferencePayload(
  recording: CaptureRecording,
  additional: Partial<CaptureRecordingEventPayload> = {},
): CaptureRecordingEventPayload {
  return {
    schemaVersion: CAPTURE_EVENT_SCHEMA_VERSION,
    recordingId: recording.id,
    byteCount: recording.byteCount,
    segmentCount: recording.segmentCount,
    transcriptSha256: recording.transcript ? sha256Text(recording.transcript) : undefined,
    transcriptByteCount: recording.transcript
      ? Buffer.byteLength(recording.transcript, "utf8")
      : 0,
    ...additional,
  };
}

async function appendCaptureRecordingEvent(
  recordingId: string,
  executionScope: ExecutionScope,
  type:
    | "capture_recording.scope_bound"
    | "capture_recording.details_changed"
    | "capture_recording.status_changed"
    | "capture_recording.deleted",
  payload: CaptureRecordingEventPayload,
  options: { sql?: ReturnType<typeof getSql> } = {},
) {
  await appendScopedDomainEvent({
    streamId: `capture-recording:${recordingId}`,
    type,
    payload,
    executionScope,
  }, options);
}

async function appendCaptureSegmentTranscriptionEvent(
  previous: CaptureSegment,
  next: CaptureSegment,
  executionScope: ExecutionScope,
  options: { sql?: ReturnType<typeof getSql> } = {},
) {
  const error = next.transcriptionError || "";
  const model = next.transcriptionModel || "";
  await appendCaptureSegmentEvent(
    next,
    executionScope,
    "capture_segment.transcription_changed",
    {
      schemaVersion: CAPTURE_EVENT_SCHEMA_VERSION,
      segmentId: next.id,
      recordingId: next.recordingId,
      segmentIndex: next.segmentIndex,
      audioSha256: next.audioSha256,
      byteCount: next.byteCount,
      previousTranscriptionStatus: previous.transcriptionStatus,
      transcriptionStatus: next.transcriptionStatus,
      transcriptSha256: next.transcript ? sha256Text(next.transcript) : undefined,
      transcriptByteCount: next.transcript
        ? Buffer.byteLength(next.transcript, "utf8")
        : 0,
      modelSha256: model ? sha256Text(model) : undefined,
      errorSha256: error ? sha256Text(error) : undefined,
      errorByteCount: error ? Buffer.byteLength(error, "utf8") : undefined,
    },
    options,
  );
}

async function appendCaptureSegmentEvent(
  segment: Pick<CaptureSegment, "id">,
  executionScope: ExecutionScope,
  type: "capture_segment.scope_bound" | "capture_segment.transcription_changed",
  payload: CaptureSegmentEventPayload,
  options: { sql?: ReturnType<typeof getSql> } = {},
) {
  await appendScopedDomainEvent({
    streamId: `capture-segment:${segment.id}`,
    type,
    payload,
    executionScope,
  }, options);
}

async function requireCaptureRecording(id: string, owner: Owner) {
  const detail = await getCaptureRecording(id, owner);
  if (!detail) throw new CaptureRecordingError("Recording not found.", 404, "recording_not_found");
  return detail;
}

function recordingFromRow(row: Record<string, unknown>): CaptureRecording {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    title: String(row.title),
    status: String(row.status) as CaptureRecordingStatus,
    language: String(row.language || "en-US"),
    tags: stringArray(row.tags),
    startedAt: iso(row.started_at),
    completedAt: optionalIso(row.completed_at),
    durationMs: Number(row.duration_ms || 0),
    byteCount: Number(row.byte_count || 0),
    segmentCount: Number(row.segment_count || 0),
    transcript: String(row.transcript || ""),
    source: String(row.source),
    knowledgeDocumentId: optionalString(row.knowledge_document_id),
    ingestJobId: optionalString(row.ingest_job_id),
    metadata: record(row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function recordingSummaryFromRow(
  row: Record<string, unknown>,
): CaptureRecordingPhysicalSummary {
  const status = typeof row.status === "string" ? row.status : "";
  const durationMs = requestRecordingInteger(
    row.duration_ms,
    MAX_CAPTURE_RECORDING_DURATION_MS,
  );
  const segmentCount = requestRecordingInteger(
    row.segment_count,
    MAX_CAPTURE_SEGMENTS,
  );
  if (
    typeof row.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,200}$/.test(row.id) ||
    typeof row.tenant_id !== "string" ||
    typeof row.actor_id !== "string" ||
    typeof row.title !== "string" ||
    row.title.length < 1 ||
    row.title.length > 240 ||
    !isCaptureRecordingStatus(status) ||
    !row.updated_at
  ) {
    throw new CaptureRecordingReadConflictError();
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    title: safeRequestRecordingTitle(row.title),
    status,
    startedAt: requestRecordingIso(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined
      ? undefined
      : requestRecordingIso(row.completed_at),
    durationMs,
    segmentCount,
    updatedAt: requestRecordingIso(row.updated_at),
  };
}

function recordingSummaryFromRecording(
  recording: CaptureRecording,
): CaptureRecordingPhysicalSummary {
  return recordingSummaryFromRow({
    id: recording.id,
    tenant_id: recording.tenantId,
    actor_id: recording.actorId,
    title: recording.title,
    status: recording.status,
    started_at: recording.startedAt,
    completed_at: recording.completedAt,
    duration_ms: recording.durationMs,
    segment_count: recording.segmentCount,
    updated_at: recording.updatedAt,
  });
}

function requestCaptureRecordingSummary(
  summary: CaptureRecordingPhysicalSummary,
  exactActorId: string,
): RequestCaptureRecordingSummary {
  const exactOwner = summary.actorId === exactActorId;
  return {
    id: summary.id,
    title: summary.title,
    status: summary.status,
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    durationMs: summary.durationMs,
    segmentCount: summary.segmentCount,
    updatedAt: summary.updatedAt,
    detailAvailable: exactOwner,
    manageable: exactOwner,
  };
}

function assertRequestCaptureRecordingSummaries(
  summaries: CaptureRecordingPhysicalSummary[],
  tenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  const ids = new Set<string>();
  for (const summary of summaries) {
    if (
      summary.tenantId !== tenantId ||
      (summary.actorId !== canonicalActorId &&
        summary.actorId !== exactActorId) ||
      ids.has(summary.id)
    ) {
      throw new CaptureRecordingReadConflictError();
    }
    ids.add(summary.id);
  }
}

function compareCaptureRecordingSummaries(
  left: CaptureRecordingPhysicalSummary,
  right: CaptureRecordingPhysicalSummary,
) {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function isCaptureRecordingStatus(
  value: string,
): value is CaptureRecordingStatus {
  return value === "recording" || value === "processing" ||
    value === "ready" || value === "failed";
}

function safeRequestRecordingTitle(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "Untitled conversation";
}

function requestRecordingIso(value: unknown) {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new CaptureRecordingReadConflictError();
  }
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CaptureRecordingReadConflictError();
  }
  const normalized = parsed.toISOString();
  if (typeof value === "string" && normalized !== value) {
    throw new CaptureRecordingReadConflictError();
  }
  return normalized;
}

function requestRecordingInteger(value: unknown, maximum: number) {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "bigint") {
    if (value < BigInt(0) || value > BigInt(maximum)) {
      throw new CaptureRecordingReadConflictError();
    }
    parsed = Number(value);
  } else if (
    typeof value === "string" &&
    /^(0|[1-9][0-9]*)$/.test(value)
  ) {
    parsed = Number(value);
  } else {
    throw new CaptureRecordingReadConflictError();
  }
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new CaptureRecordingReadConflictError();
  }
  return parsed;
}

function segmentFromRow(row: Record<string, unknown>): CaptureSegment {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    recordingId: String(row.recording_id),
    segmentIndex: Number(row.segment_index),
    mimeType: String(row.mime_type),
    byteCount: Number(row.byte_count || 0),
    durationMs: Number(row.duration_ms || 0),
    audioSha256: String(row.audio_sha256),
    transcript: String(row.transcript || ""),
    transcriptionStatus: String(row.transcription_status || "pending") as CaptureTranscriptionStatus,
    transcriptionModel: optionalString(row.transcription_model),
    transcriptionError: optionalString(row.transcription_error),
    metadata: record(row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function getCaptureLedgerFile() { return getDataPath("capture-recordings.json"); }
function getCaptureAudioDirectory(recordingId: string) { return getDataPath("capture-audio", normalizeId(recordingId)); }
function emptyLedger(): CaptureLedger { return { recordings: [], segments: [] }; }
async function readCaptureLedger() { return readJsonFile<CaptureLedger>(getCaptureLedgerFile(), emptyLedger()); }
function withoutAudioPath(segment: CaptureLedger["segments"][number]): CaptureSegment { const { audioPath, ...publicSegment } = segment; void audioPath; return publicSegment; }
function stripSegments(detail: CaptureRecordingDetail): CaptureRecording { const { segments, ...recording } = detail; void segments; return recording; }
function normalizeId(value: string) { const id = value.trim(); if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new CaptureRecordingError("Invalid recording id."); return id; }
function normalizeTenantId(value: string) { return value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default"; }
function normalizeActorId(value: string) {
  const actorId = value.trim();
  if (actorId.length > 256) {
    throw new Error("Capture recording actor identity exceeds 256 characters.");
  }
  return actorId || "anonymous";
}
function normalizeLanguage(value?: string) { const language = value?.trim().slice(0, 35) || "en-US"; return /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language) ? language : "en-US"; }
function normalizeMimeType(value: string) { return value.split(";", 1)[0].trim().toLowerCase().slice(0, 120) || "application/octet-stream"; }
function normalizeTags(values: string[]) { return [...new Set(values.map((value) => safeShort(value, 80).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")).filter(Boolean))].slice(0, 50); }
function safeTitle(value: string) { return safeShort(value, 240) || "Untitled conversation"; }
function safeTranscript(value: string) { return String(redactSensitive(value)).trim().slice(0, 100_000); }
function safeShort(value: unknown, limit: number) { return String(redactSensitive(String(value || ""))).trim().slice(0, limit); }
function sanitizeMetadata(value?: Record<string, unknown>) { return record(redactSensitive(value || {})); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringArray(value: unknown) { return Array.isArray(value) ? value.map(String) : []; }
function optionalString(value: unknown) { const text = String(value || "").trim(); return text || undefined; }
function iso(value: unknown) { return new Date(String(value)).toISOString(); }
function optionalIso(value: unknown) { return value ? iso(value) : undefined; }
function formatCaptureDate(value: string) { return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)); }
function sha256Text(value: string) { return createHash("sha256").update(value).digest("hex"); }
function sha256Json(value: unknown) { return sha256Text(JSON.stringify(value)); }
function captureRecordingDetailsSha256(recording: CaptureRecording) {
  return sha256Json({
    title: recording.title,
    language: recording.language,
    tags: recording.tags,
  });
}

function requireCaptureRecordingMutationScope(owner: ScopedOwner) {
  const executionScope = parsePersistedExecutionScope(owner.executionScope);
  if (!executionScope) throw new Error("Capture recording mutation requires a trusted execution scope.");
  const tenantId = normalizeTenantId(owner.tenantId);
  const actorId = normalizeActorId(owner.actorId);
  assertExecutionScopeTenant(executionScope, tenantId);
  if (executionScope.initiatingActorId !== actorId) {
    throw new Error("Capture recording execution scope does not match the authorized actor.");
  }
  if (!executionScope.executingPrincipalId) {
    throw new Error("Capture recording execution scope requires an executing principal.");
  }
  if (
    executionScope.executingPrincipalType === "user" &&
    executionScope.executingPrincipalId !== actorId
  ) {
    throw new Error("Capture recording user principal does not match the authorized actor.");
  }
  return executionScope;
}
