import {
  captureMediaOutputSchema,
  captureMediaProcessingRequestSchema,
  sha256Json,
  withCaptureMediaOutputDigest,
  type CaptureMediaOutput,
  type CaptureMediaProcessingRequest,
} from "@/lib/capture/media-contracts";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";

export type CaptureMediaProcessingStatus =
  | "queued"
  | "processing"
  | "waiting"
  | "ready"
  | "failed";

export type CaptureMediaHead = {
  tenantId: string;
  ownerActorId: string;
  recordingId: string;
  meetingId?: string;
  processingStatus: CaptureMediaProcessingStatus;
  processingGeneration: number;
  operationJobId: string;
  output?: CaptureMediaOutput;
  rawAudioRetention: CaptureMediaProcessingRequest["rawAudioRetention"];
  rawAudioDeletedAt?: string;
  lastErrorSha256?: string;
  createdAt: string;
  updatedAt: string;
};

type MediaOwner = {
  tenantId: string;
  actorId: string;
};

type ScopedMediaOwner = MediaOwner & {
  executionScope: ExecutionScope;
};

type CaptureMediaLedger = {
  heads: CaptureMediaHead[];
  revisions: CaptureMediaOutput[];
};

export async function getCaptureMediaHead(
  recordingIdInput: string,
  owner: MediaOwner,
) {
  const tenantId = normalizeTenantId(owner.tenantId);
  const ownerActorId = normalizeActorId(owner.actorId);
  const recordingId = normalizeId(recordingIdInput);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_capture_media_heads
      WHERE tenant_id = ${tenantId}
        AND owner_actor_id = ${ownerActorId}
        AND recording_id = ${recordingId}
      LIMIT 1
    `;
    return rows[0] ? captureMediaHeadFromRow(rows[0]) : undefined;
  }
  const ledger = await readMediaLedger();
  return ledger.heads.find((head) =>
    head.tenantId === tenantId &&
    head.ownerActorId === ownerActorId &&
    head.recordingId === recordingId
  );
}

export async function queueCaptureMediaProcessing(input: ScopedMediaOwner & {
  request: CaptureMediaProcessingRequest;
  operationJobId: string;
}) {
  const request = captureMediaProcessingRequestSchema.parse(input.request);
  const tenantId = normalizeTenantId(input.tenantId);
  const ownerActorId = normalizeActorId(input.actorId);
  const operationJobId = normalizeId(input.operationJobId);
  assertExecutionActor(input.executionScope, tenantId, ownerActorId);
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const existingRows = await sql`
        SELECT * FROM omni_capture_media_heads
        WHERE tenant_id = ${tenantId}
          AND owner_actor_id = ${ownerActorId}
          AND recording_id = ${request.recordingId}
        FOR UPDATE
      `;
      const existing = existingRows[0]
        ? captureMediaHeadFromRow(existingRows[0])
        : undefined;
      if (existing?.rawAudioDeletedAt) {
        throw new Error("Raw audio has already been deleted for this recording.");
      }
      const rows = existing
        ? await sql`
            UPDATE omni_capture_media_heads
            SET meeting_id = ${request.meetingId || null},
                processing_status = 'queued',
                processing_generation = processing_generation + 1,
                operation_job_id = ${operationJobId},
                raw_audio_retention_mode = ${request.rawAudioRetention.mode},
                raw_audio_retain_until = ${request.rawAudioRetention.retainUntil || null},
                last_error_sha256 = NULL,
                updated_by_actor_id = ${ownerActorId},
                updated_at = GREATEST(clock_timestamp(), updated_at + INTERVAL '1 microsecond')
            WHERE tenant_id = ${tenantId}
              AND owner_actor_id = ${ownerActorId}
              AND recording_id = ${request.recordingId}
            RETURNING *
          `
        : await sql`
            INSERT INTO omni_capture_media_heads (
              tenant_id, owner_actor_id, recording_id, meeting_id,
              processing_status, processing_generation, operation_job_id,
              raw_audio_retention_mode, raw_audio_retain_until,
              created_by_actor_id, updated_by_actor_id, created_at, updated_at
            ) VALUES (
              ${tenantId}, ${ownerActorId}, ${request.recordingId},
              ${request.meetingId || null}, 'queued', 1, ${operationJobId},
              ${request.rawAudioRetention.mode},
              ${request.rawAudioRetention.retainUntil || null},
              ${ownerActorId}, ${ownerActorId}, ${now}, ${now}
            )
            RETURNING *
          `;
      const head = captureMediaHeadFromRow(rows[0]);
      await appendMediaEvent(
        head,
        input.executionScope,
        "capture_media.processing_queued",
        { operationJobId: head.operationJobId },
        { sql },
      );
      return head;
    }) as Promise<CaptureMediaHead>;
  }
  let saved: CaptureMediaHead | undefined;
  await updateJsonFile<CaptureMediaLedger>(
    getMediaLedgerFile(),
    emptyMediaLedger(),
    (ledger) => {
      const existing = ledger.heads.find((head) =>
        head.tenantId === tenantId &&
        head.ownerActorId === ownerActorId &&
        head.recordingId === request.recordingId
      );
      if (existing?.rawAudioDeletedAt) {
        throw new Error("Raw audio has already been deleted for this recording.");
      }
      saved = {
        tenantId,
        ownerActorId,
        recordingId: request.recordingId,
        meetingId: request.meetingId,
        processingStatus: "queued",
        processingGeneration: (existing?.processingGeneration || 0) + 1,
        operationJobId,
        output: existing?.output,
        rawAudioRetention: request.rawAudioRetention,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      return {
        ...ledger,
        heads: [
          ...ledger.heads.filter((head) => !sameHead(head, saved!)),
          saved,
        ],
      };
    },
  );
  await appendMediaEvent(
    saved!,
    input.executionScope,
    "capture_media.processing_queued",
    { operationJobId },
  );
  return saved!;
}

export async function markCaptureMediaProcessingStatus(
  recordingIdInput: string,
  owner: ScopedMediaOwner,
  input: {
    operationJobId: string;
    status: Exclude<CaptureMediaProcessingStatus, "queued" | "ready">;
    error?: string;
  },
) {
  const tenantId = normalizeTenantId(owner.tenantId);
  const ownerActorId = normalizeActorId(owner.actorId);
  const recordingId = normalizeId(recordingIdInput);
  const operationJobId = normalizeId(input.operationJobId);
  assertExecutionActor(owner.executionScope, tenantId, ownerActorId);
  const errorSha256 = input.error ? sha256Json(input.error) : undefined;
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_capture_media_heads
      SET processing_status = ${input.status},
          processing_generation = processing_generation + 1,
          last_error_sha256 = ${errorSha256 || null},
          updated_by_actor_id = ${ownerActorId},
          updated_at = GREATEST(clock_timestamp(), updated_at + INTERVAL '1 microsecond')
      WHERE tenant_id = ${tenantId}
        AND owner_actor_id = ${ownerActorId}
        AND recording_id = ${recordingId}
        AND operation_job_id = ${operationJobId}
      RETURNING *
    `;
    if (!rows[0]) throw new Error("Media processing head is stale or missing.");
    const head = captureMediaHeadFromRow(rows[0]);
    await appendMediaEvent(
      head,
      owner.executionScope,
      `capture_media.processing_${input.status}`,
      { operationJobId, errorSha256 },
    );
    return head;
  }
  let saved: CaptureMediaHead | undefined;
  await updateJsonFile<CaptureMediaLedger>(
    getMediaLedgerFile(),
    emptyMediaLedger(),
    (ledger) => ({
      ...ledger,
      heads: ledger.heads.map((head) => {
        if (
          head.tenantId !== tenantId ||
          head.ownerActorId !== ownerActorId ||
          head.recordingId !== recordingId ||
          head.operationJobId !== operationJobId
        ) return head;
        saved = {
          ...head,
          processingStatus: input.status,
          processingGeneration: head.processingGeneration + 1,
          lastErrorSha256: errorSha256,
          updatedAt: now,
        };
        return saved;
      }),
    }),
  );
  if (!saved) throw new Error("Media processing head is stale or missing.");
  await appendMediaEvent(
    saved,
    owner.executionScope,
    `capture_media.processing_${input.status}`,
    { operationJobId, errorSha256 },
  );
  return saved;
}

export async function commitCaptureMediaOutput(
  owner: ScopedMediaOwner,
  operationJobIdInput: string,
  draft: Omit<
    CaptureMediaOutput,
    "mediaRevision" | "mediaRevisionId" | "outputSha256" | "processedAt"
  >,
) {
  const tenantId = normalizeTenantId(owner.tenantId);
  const ownerActorId = normalizeActorId(owner.actorId);
  const operationJobId = normalizeId(operationJobIdInput);
  assertExecutionActor(owner.executionScope, tenantId, ownerActorId);
  if (draft.tenantId !== tenantId || draft.ownerActorId !== ownerActorId) {
    throw new Error("Media output does not match its execution owner.");
  }
  const processedAt = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const headRows = await sql`
        SELECT * FROM omni_capture_media_heads
        WHERE tenant_id = ${tenantId}
          AND owner_actor_id = ${ownerActorId}
          AND recording_id = ${draft.recordingId}
          AND operation_job_id = ${operationJobId}
        FOR UPDATE
      `;
      if (!headRows[0]) throw new Error("Media processing head is stale or missing.");
      const head = captureMediaHeadFromRow(headRows[0]);
      if (head.output && captureMediaOutputMatchesDraft(head.output, draft)) {
        return head.output;
      }
      const mediaRevision = (head.output?.mediaRevision || 0) + 1;
      const output = withCaptureMediaOutputDigest({
        ...draft,
        mediaRevision,
        mediaRevisionId: `${draft.recordingId}:media:v${mediaRevision}`,
        processedAt,
      });
      await sql`
        INSERT INTO omni_capture_media_revisions (
          tenant_id, owner_actor_id, recording_id, media_revision,
          media_revision_id, meeting_id, source_audio_manifest_sha256,
          output_sha256, output_snapshot, created_by_actor_id, created_at
        ) VALUES (
          ${tenantId}, ${ownerActorId}, ${draft.recordingId}, ${mediaRevision},
          ${output.mediaRevisionId}, ${output.meetingId || null},
          ${output.sourceAudioManifestSha256}, ${output.outputSha256},
          ${output}::jsonb, ${ownerActorId}, ${processedAt}
        )
      `;
      const updatedRows = await sql`
        UPDATE omni_capture_media_heads
        SET meeting_id = ${output.meetingId || null},
            processing_status = 'ready',
            processing_generation = processing_generation + 1,
            current_media_revision = ${mediaRevision},
            current_media_revision_id = ${output.mediaRevisionId},
            source_audio_manifest_sha256 = ${output.sourceAudioManifestSha256},
            output_sha256 = ${output.outputSha256},
            output_snapshot = ${output}::jsonb,
            last_error_sha256 = NULL,
            updated_by_actor_id = ${ownerActorId},
            updated_at = GREATEST(clock_timestamp(), updated_at + INTERVAL '1 microsecond')
        WHERE tenant_id = ${tenantId}
          AND owner_actor_id = ${ownerActorId}
          AND recording_id = ${draft.recordingId}
          AND operation_job_id = ${operationJobId}
        RETURNING *
      `;
      if (!updatedRows[0]) throw new Error("Media output projection was not advanced.");
      const updated = captureMediaHeadFromRow(updatedRows[0]);
      await appendMediaEvent(
        updated,
        owner.executionScope,
        "capture_media.output_committed",
        {
          operationJobId,
          mediaRevisionId: output.mediaRevisionId,
          outputSha256: output.outputSha256,
          sourceAudioManifestSha256: output.sourceAudioManifestSha256,
        },
        { sql },
      );
      return output;
    }) as Promise<CaptureMediaOutput>;
  }
  let output: CaptureMediaOutput | undefined;
  let savedHead: CaptureMediaHead | undefined;
  await updateJsonFile<CaptureMediaLedger>(
    getMediaLedgerFile(),
    emptyMediaLedger(),
    (ledger) => {
      const head = ledger.heads.find((candidate) =>
        candidate.tenantId === tenantId &&
        candidate.ownerActorId === ownerActorId &&
        candidate.recordingId === draft.recordingId &&
        candidate.operationJobId === operationJobId
      );
      if (!head) throw new Error("Media processing head is stale or missing.");
      if (head.output && captureMediaOutputMatchesDraft(head.output, draft)) {
        output = head.output;
        savedHead = head;
        return ledger;
      }
      const mediaRevision = (head.output?.mediaRevision || 0) + 1;
      output = withCaptureMediaOutputDigest({
        ...draft,
        mediaRevision,
        mediaRevisionId: `${draft.recordingId}:media:v${mediaRevision}`,
        processedAt,
      });
      savedHead = {
        ...head,
        processingStatus: "ready",
        processingGeneration: head.processingGeneration + 1,
        output,
        lastErrorSha256: undefined,
        updatedAt: processedAt,
      };
      return {
        heads: ledger.heads.map((candidate) =>
          sameHead(candidate, head) ? savedHead! : candidate
        ),
        revisions: [...ledger.revisions, output],
      };
    },
  );
  await appendMediaEvent(
    savedHead!,
    owner.executionScope,
    "capture_media.output_committed",
    {
      operationJobId,
      mediaRevisionId: output!.mediaRevisionId,
      outputSha256: output!.outputSha256,
      sourceAudioManifestSha256: output!.sourceAudioManifestSha256,
    },
  );
  return output!;
}

function captureMediaOutputMatchesDraft(
  output: CaptureMediaOutput,
  draft: Omit<
    CaptureMediaOutput,
    "mediaRevision" | "mediaRevisionId" | "outputSha256" | "processedAt"
  >,
) {
  const {
    mediaRevision: _mediaRevision,
    mediaRevisionId: _mediaRevisionId,
    outputSha256: _outputSha256,
    processedAt: _processedAt,
    ...existingDraft
  } = output;
  return sha256Json(existingDraft) === sha256Json(draft);
}

export async function markCaptureMediaRawAudioDeleted(
  recordingIdInput: string,
  owner: ScopedMediaOwner,
  operationJobIdInput: string,
  deletedAtInput: string,
) {
  const tenantId = normalizeTenantId(owner.tenantId);
  const ownerActorId = normalizeActorId(owner.actorId);
  const recordingId = normalizeId(recordingIdInput);
  const operationJobId = normalizeId(operationJobIdInput);
  const deletedAt = new Date(deletedAtInput).toISOString();
  assertExecutionActor(owner.executionScope, tenantId, ownerActorId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_capture_media_heads
      SET raw_audio_deleted_at = COALESCE(raw_audio_deleted_at, ${deletedAt}),
          processing_generation = processing_generation + 1,
          updated_by_actor_id = ${ownerActorId},
          updated_at = GREATEST(clock_timestamp(), updated_at + INTERVAL '1 microsecond')
      WHERE tenant_id = ${tenantId}
        AND owner_actor_id = ${ownerActorId}
        AND recording_id = ${recordingId}
        AND operation_job_id = ${operationJobId}
        AND processing_status = 'ready'
      RETURNING *
    `;
    if (!rows[0]) throw new Error("Ready media output was not found for raw-audio deletion.");
    return captureMediaHeadFromRow(rows[0]);
  }
  let saved: CaptureMediaHead | undefined;
  await updateJsonFile<CaptureMediaLedger>(
    getMediaLedgerFile(),
    emptyMediaLedger(),
    (ledger) => ({
      ...ledger,
      heads: ledger.heads.map((head) => {
        if (
          head.tenantId !== tenantId ||
          head.ownerActorId !== ownerActorId ||
          head.recordingId !== recordingId ||
          head.operationJobId !== operationJobId ||
          head.processingStatus !== "ready"
        ) return head;
        saved = {
          ...head,
          rawAudioDeletedAt: head.rawAudioDeletedAt || deletedAt,
          processingGeneration: head.processingGeneration + 1,
          updatedAt: deletedAt,
        };
        return saved;
      }),
    }),
  );
  if (!saved) throw new Error("Ready media output was not found for raw-audio deletion.");
  return saved;
}

export function captureMediaHeadFromRow(row: Record<string, unknown>): CaptureMediaHead {
  const outputValue = parseObject(row.output_snapshot);
  const output = outputValue
    ? captureMediaOutputSchema.parse(outputValue)
    : undefined;
  const retentionMode = String(row.raw_audio_retention_mode || "");
  if (retentionMode !== "retain" && retentionMode !== "delete_after_processing") {
    throw new Error("Stored media retention mode is invalid.");
  }
  const status = String(row.processing_status || "");
  if (!["queued", "processing", "waiting", "ready", "failed"].includes(status)) {
    throw new Error("Stored media processing status is invalid.");
  }
  return {
    tenantId: String(row.tenant_id),
    ownerActorId: String(row.owner_actor_id),
    recordingId: String(row.recording_id),
    meetingId: optionalString(row.meeting_id),
    processingStatus: status as CaptureMediaProcessingStatus,
    processingGeneration: Number(row.processing_generation),
    operationJobId: String(row.operation_job_id),
    output,
    rawAudioRetention: {
      mode: retentionMode,
      ...(row.raw_audio_retain_until
        ? { retainUntil: iso(row.raw_audio_retain_until) }
        : {}),
    },
    rawAudioDeletedAt: optionalIso(row.raw_audio_deleted_at),
    lastErrorSha256: optionalString(row.last_error_sha256),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function assertExecutionActor(
  scope: ExecutionScope,
  tenantId: string,
  actorId: string,
) {
  if (
    scope.tenantId !== tenantId ||
    scope.initiatingActorId !== actorId ||
    scope.projectId !== null ||
    scope.missionId !== null
  ) {
    throw new Error("Media processing execution scope does not match its owner.");
  }
}

function appendMediaEvent(
  head: CaptureMediaHead,
  executionScope: ExecutionScope,
  type: string,
  details: Record<string, unknown>,
  options: { sql?: ReturnType<typeof getSql> } = {},
) {
  const payload = {
    schemaVersion: 1,
    recordingId: head.recordingId,
    processingStatus: head.processingStatus,
    processingGeneration: head.processingGeneration,
    ...details,
  };
  return appendScopedDomainEvent({
    id: `capture_media_event_${sha256Json({
      type,
      correlationId: executionScope.correlationId,
      causationId: executionScope.causationId,
      payload,
    })}`,
    streamId: `capture-media:${head.recordingId}`,
    type,
    payload,
    executionScope,
  }, options);
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return undefined;
}

function sameHead(left: CaptureMediaHead, right: CaptureMediaHead) {
  return left.tenantId === right.tenantId &&
    left.ownerActorId === right.ownerActorId &&
    left.recordingId === right.recordingId;
}

function normalizeTenantId(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default";
}

function normalizeActorId(value: string) {
  const actorId = value.trim();
  if (!actorId || actorId.length > 320) throw new Error("Invalid media owner actor.");
  return actorId;
}

function normalizeId(value: string) {
  const id = value.trim();
  if (!/^[a-zA-Z0-9_.:-]{1,260}$/.test(id)) throw new Error("Invalid media identifier.");
  return id;
}

function optionalString(value: unknown) {
  const text = String(value || "").trim();
  return text || undefined;
}

function iso(value: unknown) {
  return new Date(String(value)).toISOString();
}

function optionalIso(value: unknown) {
  return value ? iso(value) : undefined;
}

function getMediaLedgerFile() {
  return getDataPath("capture-media-processing.json");
}

function emptyMediaLedger(): CaptureMediaLedger {
  return { heads: [], revisions: [] };
}

function readMediaLedger() {
  return readJsonFile<CaptureMediaLedger>(getMediaLedgerFile(), emptyMediaLedger());
}
