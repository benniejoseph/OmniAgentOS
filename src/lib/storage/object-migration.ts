import { createHash } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  enqueueOperationJob,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import { getCurrentTenantCapabilityRollout } from "@/lib/rollouts/tenant-capability-rollouts";
import {
  assertExecutionScopeTenant,
  deriveExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import {
  retryFailedAssetObjectCommit,
  stageAssetObject,
  type AssetObjectSourceKind,
} from "@/lib/storage/object-plane";

export const ASSET_OBJECT_MIGRATION_SCHEMA_VERSION = 1 as const;
export const ASSET_OBJECT_MIGRATION_BATCH_SIZE = 25;
export const ASSET_OBJECT_MIGRATION_MAX_VERIFY_ATTEMPTS = 20;
export const ASSET_OBJECT_READ_CAPABILITY_ID = "asset-object-read-v1";
export const ASSET_OBJECT_READ_ENGINE_VERSION = "asset-object-reader-v1";
export const ASSET_OBJECT_READ_CONTRACT_VERSION = "tenant-asset-object-read-v1";
export const ASSET_OBJECT_READ_CONFIGURATION_SHA256 =
  "4c48b9c7101061cced0a53b5f3211043a5e86d15cfccccf3301e60d7e05deed4";

export type AssetObjectMigrationStatus =
  | "queued"
  | "running"
  | "verifying"
  | "completed"
  | "failed";

export type AssetObjectMigrationRecord = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  generation: number;
  status: AssetObjectMigrationStatus;
  cursorKind: AssetObjectSourceKind | null;
  cursorId: string | null;
  totalCount: number;
  readyCount: number;
  pendingCount: number;
  failedCount: number;
  missingCount: number;
  mismatchCount: number;
  verificationSha256: string | null;
  operationJobId: string | null;
  executionScope: ExecutionScope;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

type MigrationCursor = Readonly<{
  kind: AssetObjectSourceKind;
  id: string;
}>;

type MigrationJobRequest = Readonly<{
  migrationId: string;
  phase: "scan" | "verify";
  cursor?: MigrationCursor;
  verifyAttempt?: number;
}>;

type LegacyAssetSource = Readonly<{
  sourceKind: AssetObjectSourceKind;
  sourceId: string;
  contentSha256: string;
  byteCount: number;
  mediaType: string;
  extractionState: "pending" | "completed" | "unsupported" | "failed";
  objectStatus: string | null;
  objectContentSha256: string | null;
  objectByteCount: number | null;
  objectMediaType: string | null;
}>;

export class AssetObjectMigrationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "database_required"
      | "invalid_contract"
      | "migration_not_found"
      | "scope_mismatch"
      | "verification_failed",
  ) {
    super(message);
    this.name = "AssetObjectMigrationError";
  }
}

export async function startAssetObjectMigration(input: {
  tenantId: string;
  ownerActorId: string;
  executionScope: ExecutionScope;
}) {
  requireDatabase();
  const tenantId = requiredText(input.tenantId, 160);
  const ownerActorId = requiredText(input.ownerActorId, 320);
  const executionScope = exactOwnerScope(
    input.executionScope,
    tenantId,
    ownerActorId,
  );
  await ensureDatabaseSchema();

  return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    await sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`asset-object-migration:${tenantId}:${ownerActorId}`}, 0)
      )
    `;
    const currentRows = await sql`
      SELECT * FROM omni_asset_object_migrations
      WHERE tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
      ORDER BY generation DESC LIMIT 1
    `;
    if (currentRows[0]) {
      const current = migrationFromRow(currentRows[0]);
      if (current.status !== "failed") return current;
    }
    const generation = currentRows[0]
      ? Number(currentRows[0].generation) + 1
      : 1;
    const id = migrationId(tenantId, ownerActorId, generation);
    const rows = await sql`
      INSERT INTO omni_asset_object_migrations (
        id, tenant_id, owner_actor_id, generation, status, execution_scope
      ) VALUES (
        ${id}, ${tenantId}, ${ownerActorId}, ${generation}, 'queued',
        ${executionScope}::jsonb
      )
      RETURNING *
    `;
    const migration = migrationFromRow(rows[0]);
    const job = await enqueueMigrationJob({
      migration,
      request: { migrationId: id, phase: "scan" },
      executionScope,
      sql,
    });
    const updatedRows = await sql`
      UPDATE omni_asset_object_migrations
      SET operation_job_id = ${job.id}, updated_at = clock_timestamp()
      WHERE id = ${id} AND tenant_id = ${tenantId}
      RETURNING *
    `;
    const updated = migrationFromRow(updatedRows[0]);
    await appendMigrationEvent(
      updated,
      executionScope,
      "asset_object_migration.started",
      {
        generation,
        operationJobId: job.id,
      },
      sql,
      job.id,
    );
    return updated;
  }) as Promise<AssetObjectMigrationRecord>;
}

export async function getLatestAssetObjectMigration(input: {
  tenantId: string;
  ownerActorId: string;
}) {
  requireDatabase();
  const tenantId = requiredText(input.tenantId, 160);
  const ownerActorId = requiredText(input.ownerActorId, 320);
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT * FROM omni_asset_object_migrations
    WHERE tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
    ORDER BY generation DESC LIMIT 1
  `;
  return rows[0] ? migrationFromRow(rows[0]) : null;
}

export async function getAssetObjectReadMode(input: {
  tenantId: string;
  ownerActorId: string;
}): Promise<"legacy" | "shadow" | "object"> {
  if (!hasDatabaseUrl()) return "legacy";
  const tenantId = requiredText(input.tenantId, 160);
  const ownerActorId = requiredText(input.ownerActorId, 320);
  const rollout = await getCurrentTenantCapabilityRollout({
    tenantId,
    capabilityId: ASSET_OBJECT_READ_CAPABILITY_ID,
  });
  if (
    !rollout || rollout.status !== "active" ||
    rollout.engineVersion !== ASSET_OBJECT_READ_ENGINE_VERSION ||
    rollout.contractVersionId !== ASSET_OBJECT_READ_CONTRACT_VERSION ||
    rollout.configurationSha256 !== ASSET_OBJECT_READ_CONFIGURATION_SHA256
  ) {
    return "legacy";
  }
  if (rollout.mode === "shadow") return "shadow";
  const migration = await getLatestAssetObjectMigration({ tenantId, ownerActorId });
  return migration?.status === "completed" && migration.verificationSha256
    ? "object"
    : "legacy";
}

export async function executeAssetObjectMigrationJob(job: OperationJobRecord) {
  if (job.type !== "asset.object.backfill") {
    throw new AssetObjectMigrationError(
      "Invalid asset object migration job type.",
      "invalid_contract",
    );
  }
  const request = migrationJobRequest(job);
  const actorId = requiredText(job.payload.actorId, 320);
  const scope = parsePersistedExecutionScope(job.payload.executionScope);
  if (!scope) {
    throw new AssetObjectMigrationError(
      "Asset object migration job scope is invalid.",
      "invalid_contract",
    );
  }
  exactOwnerScope(scope, job.tenantId, actorId);
  await ensureDatabaseSchema();
  const migration = await getMigrationForJob(
    request.migrationId,
    job.tenantId,
    actorId,
  );
  if (migration.status === "completed") {
    return migrationResult(migration);
  }
  if (migration.status === "failed") {
    throw new AssetObjectMigrationError(
      "Asset object migration is already failed.",
      "verification_failed",
    );
  }
  return request.phase === "scan"
    ? executeMigrationScan(job, migration, request)
    : executeMigrationVerification(job, migration, request);
}

async function executeMigrationScan(
  job: OperationJobRecord,
  migration: AssetObjectMigrationRecord,
  request: MigrationJobRequest,
) {
  const sql = getSql();
  const workerScope = migrationWorkerScope(migration, job.id, "scan");
  const sources = await listLegacyAssetSources(
    migration.tenantId,
    migration.ownerActorId,
    request.cursor,
    sql,
  );

  for (const source of sources) {
    if (matchingObject(source)) {
      if (source.objectStatus === "failed") {
        await retryFailedAssetObjectCommit({
          tenantId: migration.tenantId,
          ownerActorId: migration.ownerActorId,
          sourceKind: source.sourceKind,
          sourceId: source.sourceId,
        }, { sql });
      }
      continue;
    }
    if (source.objectStatus !== null) continue;
    await stageAssetObject({
      tenantId: migration.tenantId,
      ownerActorId: migration.ownerActorId,
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      contentSha256: source.contentSha256,
      byteCount: source.byteCount,
      mediaType: source.mediaType,
      extractionState: source.extractionState,
      executionScope: workerScope,
      permissionGrantIds: ["first_party.capture"],
      allowedPurposeIds: source.sourceKind === "capture_asset"
        ? ["capture.asset.download", "capture.asset.extract"]
        : ["capture.recording.playback", "capture.recording.transcribe"],
      retentionPolicyId: "retention.capture.owner-controlled",
    }, { sql });
  }

  const last = sources.at(-1);
  const cursor = last
    ? { kind: last.sourceKind, id: last.sourceId }
    : request.cursor;
  const hasMore = sources.length === ASSET_OBJECT_MIGRATION_BATCH_SIZE;
  const nextRequest: MigrationJobRequest = hasMore
    ? { migrationId: migration.id, phase: "scan", cursor }
    : { migrationId: migration.id, phase: "verify", verifyAttempt: 1 };
  const nextJob = await enqueueMigrationJob({
    migration,
    request: nextRequest,
    executionScope: migration.executionScope,
    sql,
    runAt: hasMore
      ? undefined
      : new Date(Date.now() + 15_000).toISOString(),
  });
  const rows = await sql`
    UPDATE omni_asset_object_migrations
    SET status = ${hasMore ? "running" : "verifying"},
        cursor_kind = ${cursor?.kind || null},
        cursor_id = ${cursor?.id || null},
        operation_job_id = ${nextJob.id},
        started_at = COALESCE(started_at, clock_timestamp()),
        updated_at = clock_timestamp()
    WHERE id = ${migration.id} AND tenant_id = ${migration.tenantId}
      AND owner_actor_id = ${migration.ownerActorId}
      AND status IN ('queued', 'running', 'verifying')
    RETURNING *
  `;
  if (!rows[0]) {
    throw new AssetObjectMigrationError(
      "Asset object migration scan lost its lifecycle fence.",
      "verification_failed",
    );
  }
  const updated = migrationFromRow(rows[0]);
  await appendMigrationEvent(
    updated,
    workerScope,
    "asset_object_migration.progressed",
    {
      generation: updated.generation,
      phase: hasMore ? "scan" : "verify",
      batchCount: sources.length,
      cursorSha256: cursor ? sha256(`${cursor.kind}:${cursor.id}`) : null,
      nextOperationJobId: nextJob.id,
    },
    sql,
    job.id,
  );
  return migrationResult(updated);
}

async function executeMigrationVerification(
  job: OperationJobRecord,
  migration: AssetObjectMigrationRecord,
  request: MigrationJobRequest,
) {
  const sql = getSql();
  const counts = await migrationCoverage(
    migration.tenantId,
    migration.ownerActorId,
    sql,
  );
  const verifyAttempt = request.verifyAttempt || 1;
  const complete = counts.totalCount === counts.readyCount &&
    counts.pendingCount === 0 && counts.failedCount === 0 &&
    counts.missingCount === 0 && counts.mismatchCount === 0;
  const unrecoverable = counts.mismatchCount > 0 ||
    verifyAttempt >= ASSET_OBJECT_MIGRATION_MAX_VERIFY_ATTEMPTS;
  const workerScope = migrationWorkerScope(migration, job.id, "verify");
  const verificationSha256 = complete
    ? sha256(JSON.stringify({
        schemaVersion: ASSET_OBJECT_MIGRATION_SCHEMA_VERSION,
        migrationId: migration.id,
        generation: migration.generation,
        ...counts,
      }))
    : null;

  if (complete) {
    const rows = await sql`
      UPDATE omni_asset_object_migrations
      SET status = 'completed', total_count = ${counts.totalCount},
          ready_count = ${counts.readyCount}, pending_count = 0,
          failed_count = 0, missing_count = 0, mismatch_count = 0,
          verification_sha256 = ${verificationSha256},
          completed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = ${migration.id} AND tenant_id = ${migration.tenantId}
        AND owner_actor_id = ${migration.ownerActorId}
        AND status IN ('queued', 'running', 'verifying')
      RETURNING *
    `;
    if (!rows[0]) {
      throw new AssetObjectMigrationError(
        "Asset object migration verification lost its lifecycle fence.",
        "verification_failed",
      );
    }
    const updated = migrationFromRow(rows[0]);
    await appendMigrationEvent(
      updated,
      workerScope,
      "asset_object_migration.completed",
      { generation: updated.generation, ...counts, verificationSha256 },
      sql,
      job.id,
    );
    return migrationResult(updated);
  }

  if (unrecoverable) {
    const rows = await sql`
      UPDATE omni_asset_object_migrations
      SET status = 'failed', total_count = ${counts.totalCount},
          ready_count = ${counts.readyCount},
          pending_count = ${counts.pendingCount},
          failed_count = ${counts.failedCount},
          missing_count = ${counts.missingCount},
          mismatch_count = ${counts.mismatchCount},
          updated_at = clock_timestamp()
      WHERE id = ${migration.id} AND tenant_id = ${migration.tenantId}
        AND owner_actor_id = ${migration.ownerActorId}
        AND status IN ('queued', 'running', 'verifying')
      RETURNING *
    `;
    const updated = rows[0] ? migrationFromRow(rows[0]) : migration;
    await appendMigrationEvent(
      updated,
      workerScope,
      "asset_object_migration.failed",
      { generation: updated.generation, verifyAttempt, ...counts },
      sql,
      job.id,
    );
    throw new AssetObjectMigrationError(
      "Asset object migration verification did not converge.",
      "verification_failed",
    );
  }

  const repair = counts.failedCount > 0 || counts.missingCount > 0;
  const nextRequest: MigrationJobRequest = repair
    ? { migrationId: migration.id, phase: "scan" }
    : {
        migrationId: migration.id,
        phase: "verify",
        verifyAttempt: verifyAttempt + 1,
      };
  const nextJob = await enqueueMigrationJob({
    migration,
    request: nextRequest,
    executionScope: migration.executionScope,
    sql,
    runAt: new Date(Date.now() + (repair ? 2_000 : 15_000)).toISOString(),
    sequence: verifyAttempt + 1,
  });
  const rows = await sql`
    UPDATE omni_asset_object_migrations
    SET status = ${repair ? "running" : "verifying"},
        cursor_kind = ${repair ? null : migration.cursorKind},
        cursor_id = ${repair ? null : migration.cursorId},
        total_count = ${counts.totalCount}, ready_count = ${counts.readyCount},
        pending_count = ${counts.pendingCount},
        failed_count = ${counts.failedCount},
        missing_count = ${counts.missingCount},
        mismatch_count = ${counts.mismatchCount},
        operation_job_id = ${nextJob.id}, updated_at = clock_timestamp()
    WHERE id = ${migration.id} AND tenant_id = ${migration.tenantId}
      AND owner_actor_id = ${migration.ownerActorId}
      AND status IN ('queued', 'running', 'verifying')
    RETURNING *
  `;
  const updated = rows[0] ? migrationFromRow(rows[0]) : migration;
  await appendMigrationEvent(
    updated,
    workerScope,
    "asset_object_migration.progressed",
    {
      generation: updated.generation,
      phase: repair ? "repair" : "verify",
      verifyAttempt,
      ...counts,
      nextOperationJobId: nextJob.id,
    },
    sql,
    job.id,
  );
  return migrationResult(updated);
}

async function listLegacyAssetSources(
  tenantId: string,
  ownerActorId: string,
  cursor: MigrationCursor | undefined,
  sql: ReturnType<typeof getSql>,
) {
  const cursorKind = cursor?.kind || "";
  const cursorId = cursor?.id || "";
  const rows = await sql`
    WITH sources AS (
      SELECT 'capture_asset'::text AS source_kind, id AS source_id,
        content_sha256, byte_count, media_type,
        extraction_status AS extraction_state
      FROM omni_capture_assets
      WHERE tenant_id = ${tenantId} AND actor_id = ${ownerActorId}
      UNION ALL
      SELECT 'capture_segment'::text AS source_kind, id AS source_id,
        audio_sha256 AS content_sha256, byte_count, mime_type AS media_type,
        transcription_status AS extraction_state
      FROM omni_capture_segments
      WHERE tenant_id = ${tenantId} AND actor_id = ${ownerActorId}
    )
    SELECT s.*, o.status AS object_status,
      o.content_sha256 AS object_content_sha256,
      o.byte_count AS object_byte_count,
      o.media_type AS object_media_type
    FROM sources s
    LEFT JOIN omni_asset_objects o
      ON o.tenant_id = ${tenantId}
      AND o.owner_actor_id = ${ownerActorId}
      AND o.source_kind = s.source_kind
      AND o.source_id = s.source_id
      AND o.object_version = 1
    WHERE (${cursor ? true : false} = false)
      OR (s.source_kind, s.source_id) > (${cursorKind}, ${cursorId})
    ORDER BY s.source_kind ASC, s.source_id ASC
    LIMIT ${ASSET_OBJECT_MIGRATION_BATCH_SIZE}
  `;
  return rows.map(sourceFromRow);
}

async function migrationCoverage(
  tenantId: string,
  ownerActorId: string,
  sql: ReturnType<typeof getSql>,
) {
  const rows = await sql`
    WITH sources AS (
      SELECT 'capture_asset'::text AS source_kind, id AS source_id,
        content_sha256, byte_count, media_type
      FROM omni_capture_assets
      WHERE tenant_id = ${tenantId} AND actor_id = ${ownerActorId}
      UNION ALL
      SELECT 'capture_segment'::text AS source_kind, id AS source_id,
        audio_sha256 AS content_sha256, byte_count, mime_type AS media_type
      FROM omni_capture_segments
      WHERE tenant_id = ${tenantId} AND actor_id = ${ownerActorId}
    ), coverage AS (
      SELECT s.*, o.id AS object_id, o.status AS object_status,
        o.content_sha256 AS object_content_sha256,
        o.byte_count AS object_byte_count,
        o.media_type AS object_media_type,
        (
          o.content_sha256 = s.content_sha256
          AND o.byte_count = s.byte_count
          AND o.media_type = s.media_type
        ) AS exact_match
      FROM sources s
      LEFT JOIN omni_asset_objects o
        ON o.tenant_id = ${tenantId}
        AND o.owner_actor_id = ${ownerActorId}
        AND o.source_kind = s.source_kind
        AND o.source_id = s.source_id
        AND o.object_version = 1
    )
    SELECT count(*)::integer AS total_count,
      count(*) FILTER (
        WHERE exact_match AND object_status = 'ready'
      )::integer AS ready_count,
      count(*) FILTER (
        WHERE exact_match AND object_status = 'pending'
      )::integer AS pending_count,
      count(*) FILTER (
        WHERE exact_match AND object_status = 'failed'
      )::integer AS failed_count,
      count(*) FILTER (WHERE object_id IS NULL)::integer AS missing_count,
      count(*) FILTER (
        WHERE object_id IS NOT NULL
          AND NOT (exact_match AND object_status IN ('ready', 'pending', 'failed'))
      )::integer AS mismatch_count
    FROM coverage
  `;
  const row = rows[0];
  return {
    totalCount: Number(row.total_count),
    readyCount: Number(row.ready_count),
    pendingCount: Number(row.pending_count),
    failedCount: Number(row.failed_count),
    missingCount: Number(row.missing_count),
    mismatchCount: Number(row.mismatch_count),
  };
}

async function getMigrationForJob(
  id: string,
  tenantId: string,
  ownerActorId: string,
) {
  const rows = await getSql()`
    SELECT * FROM omni_asset_object_migrations
    WHERE id = ${id} AND tenant_id = ${tenantId}
      AND owner_actor_id = ${ownerActorId}
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new AssetObjectMigrationError(
      "Asset object migration was not found.",
      "migration_not_found",
    );
  }
  return migrationFromRow(rows[0]);
}

async function enqueueMigrationJob(input: {
  migration: AssetObjectMigrationRecord;
  request: MigrationJobRequest;
  executionScope: ExecutionScope;
  sql: ReturnType<typeof getSql>;
  runAt?: string;
  sequence?: number;
}) {
  const cursorDigest = input.request.cursor
    ? sha256(`${input.request.cursor.kind}:${input.request.cursor.id}`).slice(0, 20)
    : "start";
  const sequence = input.sequence || input.request.verifyAttempt || 1;
  return enqueueOperationJob({
    tenantId: input.migration.tenantId,
    type: "asset.object.backfill",
    dedupeMode: "idempotent",
    dedupeKey: [
      "asset.object.backfill",
      input.migration.id,
      input.request.phase,
      cursorDigest,
      sequence,
    ].join(":"),
    priority: input.request.phase === "scan" ? 2 : 1,
    maxAttempts: 8,
    runAt: input.runAt,
    payload: {
      request: input.request,
      actorId: input.migration.ownerActorId,
      executionScope: input.executionScope,
      progress: { stage: input.request.phase },
    },
  }, { sql: input.sql });
}

function migrationJobRequest(job: OperationJobRecord): MigrationJobRequest {
  const value = job.payload.request;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssetObjectMigrationError(
      "Asset object migration request is missing.",
      "invalid_contract",
    );
  }
  const request = value as Record<string, unknown>;
  const migrationId = typeof request.migrationId === "string"
    ? request.migrationId
    : "";
  const phase = request.phase;
  if (
    !/^asset_migration_[a-f0-9]{48}$/.test(migrationId) ||
    (phase !== "scan" && phase !== "verify")
  ) {
    throw new AssetObjectMigrationError(
      "Asset object migration request is invalid.",
      "invalid_contract",
    );
  }
  let cursor: MigrationCursor | undefined;
  if (request.cursor !== undefined) {
    if (!request.cursor || typeof request.cursor !== "object" || Array.isArray(request.cursor)) {
      throw new AssetObjectMigrationError("Migration cursor is invalid.", "invalid_contract");
    }
    const candidate = request.cursor as Record<string, unknown>;
    if (
      (candidate.kind !== "capture_asset" && candidate.kind !== "capture_segment") ||
      typeof candidate.id !== "string" || !candidate.id || candidate.id.length > 200
    ) {
      throw new AssetObjectMigrationError("Migration cursor is invalid.", "invalid_contract");
    }
    cursor = { kind: candidate.kind, id: candidate.id };
  }
  const verifyAttempt = request.verifyAttempt === undefined
    ? undefined
    : Number(request.verifyAttempt);
  if (
    verifyAttempt !== undefined &&
    (!Number.isInteger(verifyAttempt) || verifyAttempt < 1 || verifyAttempt > 100)
  ) {
    throw new AssetObjectMigrationError(
      "Migration verification attempt is invalid.",
      "invalid_contract",
    );
  }
  return { migrationId, phase, cursor, verifyAttempt };
}

function sourceFromRow(row: Record<string, unknown>): LegacyAssetSource {
  return {
    sourceKind: String(row.source_kind) as AssetObjectSourceKind,
    sourceId: String(row.source_id),
    contentSha256: String(row.content_sha256),
    byteCount: Number(row.byte_count),
    mediaType: String(row.media_type).toLowerCase(),
    extractionState: String(row.extraction_state) as LegacyAssetSource["extractionState"],
    objectStatus: row.object_status ? String(row.object_status) : null,
    objectContentSha256: row.object_content_sha256
      ? String(row.object_content_sha256)
      : null,
    objectByteCount: row.object_byte_count === null || row.object_byte_count === undefined
      ? null
      : Number(row.object_byte_count),
    objectMediaType: row.object_media_type
      ? String(row.object_media_type)
      : null,
  };
}

function matchingObject(source: LegacyAssetSource) {
  return source.objectStatus !== null &&
    source.objectContentSha256 === source.contentSha256 &&
    source.objectByteCount === source.byteCount &&
    source.objectMediaType === source.mediaType;
}

function migrationFromRow(row: Record<string, unknown>): AssetObjectMigrationRecord {
  const executionScope = parsePersistedExecutionScope(row.execution_scope);
  if (!executionScope) {
    throw new AssetObjectMigrationError(
      "Stored asset object migration scope is invalid.",
      "invalid_contract",
    );
  }
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    ownerActorId: String(row.owner_actor_id),
    generation: Number(row.generation),
    status: String(row.status) as AssetObjectMigrationStatus,
    cursorKind: row.cursor_kind
      ? String(row.cursor_kind) as AssetObjectSourceKind
      : null,
    cursorId: row.cursor_id ? String(row.cursor_id) : null,
    totalCount: Number(row.total_count),
    readyCount: Number(row.ready_count),
    pendingCount: Number(row.pending_count),
    failedCount: Number(row.failed_count),
    missingCount: Number(row.missing_count),
    mismatchCount: Number(row.mismatch_count),
    verificationSha256: row.verification_sha256
      ? String(row.verification_sha256)
      : null,
    operationJobId: row.operation_job_id ? String(row.operation_job_id) : null,
    executionScope,
    startedAt: timestamp(row.started_at),
    completedAt: timestamp(row.completed_at),
    createdAt: timestamp(row.created_at)!,
    updatedAt: timestamp(row.updated_at)!,
  };
}

function migrationWorkerScope(
  migration: AssetObjectMigrationRecord,
  jobId: string,
  phase: "scan" | "verify",
) {
  return deriveExecutionScope(migration.executionScope, {
    executingPrincipalType: "system",
    executingPrincipalId: "asset-object-backfill-worker",
    causationId: jobId,
    purpose: `asset.object.backfill.${phase}`,
  });
}

async function appendMigrationEvent(
  migration: AssetObjectMigrationRecord,
  executionScope: ExecutionScope,
  type:
    | "asset_object_migration.started"
    | "asset_object_migration.progressed"
    | "asset_object_migration.completed"
    | "asset_object_migration.failed",
  payload: Record<string, unknown>,
  sql: ReturnType<typeof getSql>,
  discriminator: string,
) {
  await appendScopedDomainEvent({
    id: `event_${sha256(JSON.stringify({
      type,
      migrationId: migration.id,
      discriminator,
    })).slice(0, 48)}`,
    streamId: migration.id,
    type,
    executionScope,
    payload: {
      schemaVersion: ASSET_OBJECT_MIGRATION_SCHEMA_VERSION,
      migrationId: migration.id,
      ...payload,
    },
  }, { sql });
}

function migrationResult(migration: AssetObjectMigrationRecord) {
  return {
    migrationId: migration.id,
    generation: migration.generation,
    status: migration.status,
    totalCount: migration.totalCount,
    readyCount: migration.readyCount,
    pendingCount: migration.pendingCount,
    failedCount: migration.failedCount,
    missingCount: migration.missingCount,
    mismatchCount: migration.mismatchCount,
    verificationSha256: migration.verificationSha256,
  };
}

function exactOwnerScope(
  scope: ExecutionScope,
  tenantId: string,
  ownerActorId: string,
) {
  assertExecutionScopeTenant(scope, tenantId);
  if (scope.initiatingActorId !== ownerActorId) {
    throw new AssetObjectMigrationError(
      "Asset object migration scope does not match its owner.",
      "scope_mismatch",
    );
  }
  return scope;
}

function migrationId(tenantId: string, actorId: string, generation: number) {
  return `asset_migration_${sha256(JSON.stringify({
    schemaVersion: ASSET_OBJECT_MIGRATION_SCHEMA_VERSION,
    tenantId,
    actorId,
    generation,
  })).slice(0, 48)}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requiredText(value: unknown, maxLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new AssetObjectMigrationError(
      "Asset object migration contract is invalid.",
      "invalid_contract",
    );
  }
  return normalized;
}

function timestamp(value: unknown) {
  return value ? new Date(String(value)).toISOString() : null;
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new AssetObjectMigrationError(
      "Asset object migration requires PostgreSQL.",
      "database_required",
    );
  }
}
