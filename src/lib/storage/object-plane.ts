import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { del, get, put } from "@vercel/blob";
import {
  ensureDatabaseSchema,
  getSql,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  enqueueOperationJob,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import {
  assertExecutionScopeTenant,
  executionScopesEqual,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

export const ASSET_OBJECT_CONTRACT_VERSION = 1 as const;
export const ASSET_OBJECT_STORAGE_PROVIDER = "vercel_blob_private" as const;
export const ASSET_DELIVERY_TTL_SECONDS = 5 * 60;

export type AssetObjectSourceKind = "capture_asset" | "capture_segment";
export type AssetObjectStatus = "pending" | "ready" | "failed" | "deleted";

export type AssetObjectRecord = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  workspaceId: string | null;
  projectId: string | null;
  missionId: string | null;
  sourceKind: AssetObjectSourceKind;
  sourceId: string;
  objectVersion: number;
  storageProvider: typeof ASSET_OBJECT_STORAGE_PROVIDER;
  storageLocator: string;
  storageEtag: string | null;
  status: AssetObjectStatus;
  contentSha256: string;
  byteCount: number;
  mediaType: string;
  visibility: "user_private";
  sensitivity: "confidential" | "restricted";
  permissionGrantIds: string[];
  allowedPurposeIds: string[];
  retentionPolicyId: string;
  retentionExpiresAt: string | null;
  extractionState: "pending" | "completed" | "unsupported" | "failed";
  uploadJobId: string | null;
  failureCount: number;
  failureCode: string | null;
  executionScope: ExecutionScope;
  readyAt: string | null;
  deletedAt: string | null;
  scrubbedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

type StageAssetObjectInput = Readonly<{
  tenantId: string;
  ownerActorId: string;
  sourceKind: AssetObjectSourceKind;
  sourceId: string;
  objectVersion?: number;
  contentSha256: string;
  byteCount: number;
  mediaType: string;
  extractionState: AssetObjectRecord["extractionState"];
  executionScope: ExecutionScope;
  workspaceId?: string | null;
  projectId?: string | null;
  missionId?: string | null;
  sensitivity?: AssetObjectRecord["sensitivity"];
  permissionGrantIds?: string[];
  allowedPurposeIds: string[];
  retentionPolicyId: string;
  retentionExpiresAt?: string | null;
}>;

export type PrivateAssetBlobAdapter = Readonly<{
  read: (
    locator: string,
    signal?: AbortSignal,
  ) => Promise<{ bytes: Uint8Array; etag: string | null } | null>;
  put: (
    locator: string,
    bytes: Uint8Array,
    mediaType: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  delete: (locator: string) => Promise<void>;
}>;

type AssetObjectEventType =
  | "asset_object.staged"
  | "asset_object.ready"
  | "asset_object.failed"
  | "asset_object.extraction_changed"
  | "asset_object.deleted"
  | "asset_object.scrubbed";

const sha256Pattern = /^[a-f0-9]{64}$/;
const objectIdPattern = /^asset_object_[a-f0-9]{48}$/;
const deliveryTokenPattern = /^ao1\.[A-Za-z0-9_-]{20,2000}\.[A-Za-z0-9_-]{43}$/;
const defaultBlobAdapter: PrivateAssetBlobAdapter = Object.freeze({
  async read(locator, signal) {
    signal?.throwIfAborted();
    const result = await get(locator, { access: "private", useCache: false });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream) {
      throw new AssetObjectError("Object storage returned an invalid read status.", "storage_read_failed");
    }
    const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
    signal?.throwIfAborted();
    return {
      bytes,
      etag: typeof result.blob.etag === "string" ? result.blob.etag : null,
    };
  },
  async put(locator, bytes, mediaType, signal) {
    signal?.throwIfAborted();
    await put(locator, Buffer.from(bytes), {
      access: "private",
      addRandomSuffix: false,
      contentType: mediaType,
      multipart: bytes.byteLength >= 5 * 1024 * 1024,
      abortSignal: signal,
      cacheControlMaxAge: 60,
    });
  },
  async delete(locator) {
    await del(locator);
  },
});

export class AssetObjectError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "database_required"
      | "invalid_contract"
      | "object_not_found"
      | "object_not_ready"
      | "source_not_current"
      | "storage_not_configured"
      | "storage_read_failed"
      | "storage_write_failed"
      | "storage_integrity_failed"
      | "delivery_token_invalid"
      | "delivery_token_expired",
  ) {
    super(message);
    this.name = "AssetObjectError";
  }
}

export function privateObjectStorageConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim() || process.env.VERCEL_OIDC_TOKEN?.trim());
}

export async function stageAssetObject(
  input: StageAssetObjectInput,
  options: { sql: ReturnType<typeof getSql> },
) {
  const normalized = normalizedStageInput(input);
  const objectId = assetObjectId(normalized);
  const storageLocator = assetObjectLocator(normalized);
  const rows = await options.sql`
    INSERT INTO omni_asset_objects (
      id, tenant_id, owner_actor_id, workspace_id, project_id, mission_id,
      source_kind, source_id, object_version, storage_provider, storage_locator,
      status, content_sha256, byte_count, media_type, visibility, sensitivity,
      permission_grant_ids, allowed_purpose_ids, retention_policy_id,
      retention_expires_at, extraction_state, execution_scope
    ) VALUES (
      ${objectId}, ${normalized.tenantId}, ${normalized.ownerActorId},
      ${normalized.workspaceId}, ${normalized.projectId}, ${normalized.missionId},
      ${normalized.sourceKind}, ${normalized.sourceId}, ${normalized.objectVersion},
      ${ASSET_OBJECT_STORAGE_PROVIDER}, ${storageLocator}, 'pending',
      ${normalized.contentSha256}, ${normalized.byteCount}, ${normalized.mediaType},
      'user_private', ${normalized.sensitivity}, ${normalized.permissionGrantIds},
      ${normalized.allowedPurposeIds}, ${normalized.retentionPolicyId},
      ${normalized.retentionExpiresAt}, ${normalized.extractionState},
      ${normalized.executionScope}::jsonb
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING *
  `;
  let object = rows[0]
    ? assetObjectFromRow(rows[0])
    : await getAssetObjectById(objectId, normalized.tenantId, options.sql);
  if (!object) {
    throw new AssetObjectError("Asset object idempotency conflict.", "invalid_contract");
  }
  assertStagedObjectMatches(object, normalized);
  if (object.status === "deleted") {
    throw new AssetObjectError("Deleted asset objects cannot be restaged.", "source_not_current");
  }
  const previousExtractionState = object.extractionState;
  const requestHash = assetObjectRequestHash(object);
  const job = await enqueueOperationJob({
    tenantId: object.tenantId,
    type: "asset.object.commit",
    dedupeKey: `asset.object.commit:${object.id}`,
    dedupeMode: "idempotent",
    priority: 3,
    maxAttempts: 8,
    payload: {
      request: { objectId: object.id, requestHash },
      actorId: object.ownerActorId,
      executionScope: object.executionScope,
      progress: { stage: "queued" },
    },
  }, { sql: options.sql });
  const updated = await options.sql`
    UPDATE omni_asset_objects
    SET upload_job_id = COALESCE(upload_job_id, ${job.id}),
        extraction_state = ${normalized.extractionState},
        updated_at = clock_timestamp()
    WHERE id = ${object.id} AND tenant_id = ${object.tenantId}
    RETURNING *
  `;
  object = assetObjectFromRow(updated[0]);
  if (object.extractionState !== previousExtractionState) {
    await appendAssetObjectEvent(
      object,
      normalized.executionScope,
      "asset_object.extraction_changed",
      {
        objectId: object.id,
        sourceKind: object.sourceKind,
        sourceIdSha256: sha256(object.sourceId),
        objectVersion: object.objectVersion,
        extractionState: object.extractionState,
      },
      options.sql,
    );
  }
  await appendAssetObjectEvent(object, normalized.executionScope, "asset_object.staged", {
    objectId: object.id,
    sourceKind: object.sourceKind,
    sourceIdSha256: sha256(object.sourceId),
    objectVersion: object.objectVersion,
    storageProvider: object.storageProvider,
    storageLocatorSha256: sha256(object.storageLocator),
    contentSha256: object.contentSha256,
    byteCount: object.byteCount,
    mediaTypeSha256: sha256(object.mediaType),
    retentionPolicyId: object.retentionPolicyId,
    extractionState: object.extractionState,
    uploadJobId: job.id,
  }, options.sql);
  return object;
}

export async function commitAssetObjectJob(
  job: OperationJobRecord,
  options: { adapter?: PrivateAssetBlobAdapter; signal?: AbortSignal } = {},
): Promise<AssetObjectRecord> {
  if (job.type !== "asset.object.commit") {
    throw new AssetObjectError("Invalid object commit job type.", "invalid_contract");
  }
  const request = assetObjectJobRequest(job);
  await ensureDatabaseSchema();
  const sql = getSql();
  const object = await getAssetObjectById(request.objectId, job.tenantId, sql);
  if (!object) {
    throw new AssetObjectError("Asset object was not found.", "object_not_found");
  }
  assertAssetObjectJobBinding(job, object, request.requestHash);
  if (object.status === "ready") {
    return object;
  }
  if (object.status === "deleted") {
    throw new AssetObjectError("Deleted asset objects cannot become ready.", "source_not_current");
  }
  if (!options.adapter && !privateObjectStorageConfigured()) {
    await recordAssetObjectFailure(object, job, "storage_not_configured");
    throw new AssetObjectError("Private object storage is not configured.", "storage_not_configured");
  }
  const executionScope = workerExecutionScope(job, object);
  const adapter = options.adapter || defaultBlobAdapter;
  try {
    options.signal?.throwIfAborted();
    const legacyBytes = await readLegacyAssetBytes(object, sql);
    assertObjectBytes(object, legacyBytes);
    let stored = await adapter.read(object.storageLocator, options.signal);
    if (!stored) {
      try {
        await adapter.put(
          object.storageLocator,
          legacyBytes,
          object.mediaType,
          options.signal,
        );
      } catch (error) {
        stored = await adapter.read(object.storageLocator, options.signal);
        if (!stored) throw error;
      }
      stored ||= await adapter.read(object.storageLocator, options.signal);
    }
    if (!stored) {
      throw new AssetObjectError("Uploaded object could not be read back.", "storage_read_failed");
    }
    assertObjectBytes(object, stored.bytes);
    return sql.transaction(async (tx: ReturnType<typeof getSql>) => {
      const readyRows = await tx`
        UPDATE omni_asset_objects
        SET status = 'ready', storage_etag = ${stored.etag}, failure_code = NULL,
            ready_at = COALESCE(ready_at, clock_timestamp()),
            updated_at = clock_timestamp()
        WHERE id = ${object.id} AND tenant_id = ${object.tenantId}
          AND owner_actor_id = ${object.ownerActorId}
          AND status IN ('pending', 'failed')
          AND content_sha256 = ${object.contentSha256}
          AND byte_count = ${object.byteCount}
        RETURNING *
      `;
      const ready = readyRows[0]
        ? assetObjectFromRow(readyRows[0])
        : await getAssetObjectById(object.id, object.tenantId, tx);
      if (!ready || ready.status !== "ready") {
        throw new AssetObjectError("Asset object readiness fence was lost.", "source_not_current");
      }
      await appendAssetObjectEvent(ready, executionScope, "asset_object.ready", {
        objectId: ready.id,
        sourceKind: ready.sourceKind,
        sourceIdSha256: sha256(ready.sourceId),
        objectVersion: ready.objectVersion,
        storageLocatorSha256: sha256(ready.storageLocator),
        contentSha256: ready.contentSha256,
        byteCount: ready.byteCount,
        storageEtagSha256: ready.storageEtag ? sha256(ready.storageEtag) : null,
      }, tx);
      return ready;
    }) as Promise<AssetObjectRecord>;
  } catch (error) {
    await recordAssetObjectFailure(object, job, assetObjectFailureCode(error));
    throw error;
  }
}

export async function retireAssetObjectsForSource(
  input: {
    tenantId: string;
    ownerActorId: string;
    sourceKind: AssetObjectSourceKind;
    sourceId: string;
    executionScope: ExecutionScope;
  },
  options: { sql: ReturnType<typeof getSql> },
) {
  const tenantId = requiredText(input.tenantId, 160);
  const ownerActorId = requiredText(input.ownerActorId, 320);
  const sourceId = requiredText(input.sourceId, 200);
  const executionScope = requiredOwnerScope(input.executionScope, tenantId, ownerActorId);
  const rows = await options.sql`
    UPDATE omni_asset_objects
    SET status = 'deleted', deleted_at = COALESCE(deleted_at, clock_timestamp()),
        updated_at = clock_timestamp()
    WHERE tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
      AND source_kind = ${input.sourceKind} AND source_id = ${sourceId}
      AND status <> 'deleted'
    RETURNING *
  `;
  const retired: AssetObjectRecord[] = [];
  for (const row of rows) {
    const object = assetObjectFromRow(row);
    const requestHash = assetObjectRequestHash(object);
    const job = await enqueueOperationJob({
      tenantId,
      type: "asset.object.delete",
      dedupeKey: `asset.object.delete:${object.id}`,
      dedupeMode: "idempotent",
      priority: 10,
      maxAttempts: 8,
      payload: {
        request: { objectId: object.id, requestHash },
        actorId: ownerActorId,
        executionScope,
        progress: { stage: "queued" },
      },
    }, { sql: options.sql });
    await appendAssetObjectEvent(object, executionScope, "asset_object.deleted", {
      objectId: object.id,
      sourceKind: object.sourceKind,
      sourceIdSha256: sha256(object.sourceId),
      objectVersion: object.objectVersion,
      storageLocatorSha256: sha256(object.storageLocator),
      deleteJobId: job.id,
    }, options.sql);
    retired.push(object);
  }
  return retired;
}

export async function updateAssetObjectExtractionState(
  input: {
    tenantId: string;
    ownerActorId: string;
    sourceKind: AssetObjectSourceKind;
    sourceId: string;
    extractionState: AssetObjectRecord["extractionState"];
    executionScope: ExecutionScope;
  },
  options: { sql: ReturnType<typeof getSql> },
) {
  const tenantId = requiredText(input.tenantId, 160);
  const ownerActorId = requiredText(input.ownerActorId, 320);
  const sourceId = requiredText(input.sourceId, 200);
  const executionScope = requiredOwnerScope(input.executionScope, tenantId, ownerActorId);
  const extractionState = normalizedExtractionState(input.extractionState);
  const rows = await options.sql`
    UPDATE omni_asset_objects
    SET extraction_state = ${extractionState}, updated_at = clock_timestamp()
    WHERE tenant_id = ${tenantId} AND owner_actor_id = ${ownerActorId}
      AND source_kind = ${input.sourceKind} AND source_id = ${sourceId}
      AND status <> 'deleted' AND extraction_state <> ${extractionState}
    RETURNING *
  `;
  for (const row of rows) {
    const object = assetObjectFromRow(row);
    await appendAssetObjectEvent(
      object,
      executionScope,
      "asset_object.extraction_changed",
      {
        objectId: object.id,
        sourceKind: object.sourceKind,
        sourceIdSha256: sha256(object.sourceId),
        objectVersion: object.objectVersion,
        extractionState: object.extractionState,
      },
      options.sql,
    );
  }
  return rows.length;
}

export async function deleteAssetObjectJob(
  job: OperationJobRecord,
  options: { adapter?: PrivateAssetBlobAdapter } = {},
): Promise<AssetObjectRecord | { objectId: string; scrubbed: true }> {
  if (job.type !== "asset.object.delete") {
    throw new AssetObjectError("Invalid object deletion job type.", "invalid_contract");
  }
  const request = assetObjectJobRequest(job);
  await ensureDatabaseSchema();
  const sql = getSql();
  const object = await getAssetObjectById(request.objectId, job.tenantId, sql);
  if (!object) return { objectId: request.objectId, scrubbed: true };
  assertAssetObjectJobBinding(job, object, request.requestHash);
  if (object.status !== "deleted") {
    throw new AssetObjectError("Only deleted asset objects may be scrubbed.", "source_not_current");
  }
  if (object.scrubbedAt) return object;
  if (!options.adapter && !privateObjectStorageConfigured()) {
    throw new AssetObjectError("Private object storage is not configured.", "storage_not_configured");
  }
  await (options.adapter || defaultBlobAdapter).delete(object.storageLocator);
  const scope = workerExecutionScope(job, object);
  return sql.transaction(async (tx: ReturnType<typeof getSql>) => {
    const rows = await tx`
      UPDATE omni_asset_objects
      SET scrubbed_at = COALESCE(scrubbed_at, clock_timestamp()),
          storage_etag = NULL, updated_at = clock_timestamp()
      WHERE id = ${object.id} AND tenant_id = ${object.tenantId}
        AND owner_actor_id = ${object.ownerActorId} AND status = 'deleted'
      RETURNING *
    `;
    const scrubbed = rows[0] ? assetObjectFromRow(rows[0]) : object;
    await appendAssetObjectEvent(scrubbed, scope, "asset_object.scrubbed", {
      objectId: scrubbed.id,
      sourceKind: scrubbed.sourceKind,
      sourceIdSha256: sha256(scrubbed.sourceId),
      objectVersion: scrubbed.objectVersion,
      storageLocatorSha256: sha256(scrubbed.storageLocator),
    }, tx);
    return scrubbed;
  }) as Promise<AssetObjectRecord>;
}

export async function issueAssetObjectDelivery(input: {
  tenantId: string;
  actorId: string;
  sourceKind: AssetObjectSourceKind;
  sourceId: string;
  purpose: string;
  objectVersion?: number;
}) {
  await ensureDatabaseSchema();
  const tenantId = requiredText(input.tenantId, 160);
  const actorId = requiredText(input.actorId, 320);
  const sourceId = requiredText(input.sourceId, 200);
  const purpose = requiredText(input.purpose, 160);
  const version = positiveInteger(input.objectVersion || 1);
  const rows = await getSql()`
    SELECT * FROM omni_asset_objects
    WHERE tenant_id = ${tenantId} AND owner_actor_id = ${actorId}
      AND source_kind = ${input.sourceKind} AND source_id = ${sourceId}
      AND object_version = ${version} AND status = 'ready'
    LIMIT 2
  `;
  if (rows.length !== 1) {
    throw new AssetObjectError("A ready asset object was not found.", "object_not_ready");
  }
  const object = assetObjectFromRow(rows[0]);
  if (!object.allowedPurposeIds.includes(purpose)) {
    throw new AssetObjectError("Asset delivery purpose is not allowed.", "source_not_current");
  }
  await assertSourceStillCurrent(object, getSql());
  const expiresAt = Date.now() + ASSET_DELIVERY_TTL_SECONDS * 1_000;
  const payload = {
    v: 1,
    objectId: object.id,
    tenantSha256: sha256(tenantId),
    actorSha256: sha256(actorId),
    purpose,
    expiresAt,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", deliverySecret())
    .update(`ao1.${encoded}`, "utf8")
    .digest("base64url");
  return {
    object: projectAssetObject(object),
    token: `ao1.${encoded}.${signature}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export async function redeemAssetObjectDelivery(input: {
  token: string;
  tenantId: string;
  actorId: string;
  purpose: string;
  adapter?: PrivateAssetBlobAdapter;
}) {
  if (!input.adapter && !privateObjectStorageConfigured()) {
    throw new AssetObjectError("Private object storage is not configured.", "storage_not_configured");
  }
  const payload = openDeliveryToken(input.token);
  const tenantId = requiredText(input.tenantId, 160);
  const actorId = requiredText(input.actorId, 320);
  const purpose = requiredText(input.purpose, 160);
  if (
    payload.tenantSha256 !== sha256(tenantId) ||
    payload.actorSha256 !== sha256(actorId) ||
    payload.purpose !== purpose
  ) {
    throw new AssetObjectError("Asset delivery token scope is invalid.", "delivery_token_invalid");
  }
  await ensureDatabaseSchema();
  const object = await getAssetObjectById(payload.objectId, tenantId, getSql());
  if (!object || object.ownerActorId !== actorId || object.status !== "ready") {
    throw new AssetObjectError("A ready asset object was not found.", "object_not_ready");
  }
  if (!object.allowedPurposeIds.includes(purpose)) {
    throw new AssetObjectError("Asset delivery purpose is not allowed.", "source_not_current");
  }
  await assertSourceStillCurrent(object, getSql());
  const stored = await (input.adapter || defaultBlobAdapter).read(object.storageLocator);
  if (!stored) {
    throw new AssetObjectError("Asset object content was not found.", "storage_read_failed");
  }
  assertObjectBytes(object, stored.bytes);
  return { object: projectAssetObject(object), bytes: stored.bytes };
}

export function projectAssetObject(object: AssetObjectRecord) {
  return {
    id: object.id,
    sourceKind: object.sourceKind,
    sourceId: object.sourceId,
    objectVersion: object.objectVersion,
    status: object.status,
    contentSha256: object.contentSha256,
    byteCount: object.byteCount,
    mediaType: object.mediaType,
    retentionPolicyId: object.retentionPolicyId,
    retentionExpiresAt: object.retentionExpiresAt,
    extractionState: object.extractionState,
    readyAt: object.readyAt,
  };
}

function normalizedStageInput(input: StageAssetObjectInput) {
  const tenantId = requiredText(input.tenantId, 160);
  const ownerActorId = requiredText(input.ownerActorId, 320);
  const executionScope = requiredOwnerScope(input.executionScope, tenantId, ownerActorId);
  const contentSha256 = input.contentSha256.trim().toLowerCase();
  if (!sha256Pattern.test(contentSha256)) {
    throw new AssetObjectError("Asset object checksum is invalid.", "invalid_contract");
  }
  const permissionGrantIds = normalizedStringSet(
    input.permissionGrantIds?.length
      ? input.permissionGrantIds
      : ["first_party.capture"],
    120,
  );
  const allowedPurposeIds = normalizedStringSet(input.allowedPurposeIds, 160);
  if (!permissionGrantIds.length || !allowedPurposeIds.length) {
    throw new AssetObjectError("Asset object grants and purposes are required.", "invalid_contract");
  }
  if (input.sourceKind !== "capture_asset" && input.sourceKind !== "capture_segment") {
    throw new AssetObjectError("Asset object source kind is invalid.", "invalid_contract");
  }
  const sensitivity = input.sensitivity || "confidential";
  if (sensitivity !== "confidential" && sensitivity !== "restricted") {
    throw new AssetObjectError("Asset object sensitivity is invalid.", "invalid_contract");
  }
  return {
    tenantId,
    ownerActorId,
    workspaceId: optionalText(
      input.workspaceId === undefined ? executionScope.workspaceId : input.workspaceId,
      200,
    ),
    projectId: optionalText(
      input.projectId === undefined ? executionScope.projectId : input.projectId,
      200,
    ),
    missionId: optionalText(
      input.missionId === undefined ? executionScope.missionId : input.missionId,
      200,
    ),
    sourceKind: input.sourceKind,
    sourceId: requiredText(input.sourceId, 200),
    objectVersion: positiveInteger(input.objectVersion || 1),
    contentSha256,
    byteCount: positiveInteger(input.byteCount),
    mediaType: requiredText(input.mediaType.toLowerCase(), 200),
    extractionState: normalizedExtractionState(input.extractionState),
    sensitivity,
    permissionGrantIds,
    allowedPurposeIds,
    retentionPolicyId: requiredText(input.retentionPolicyId, 120),
    retentionExpiresAt: optionalTimestamp(input.retentionExpiresAt),
    executionScope,
  };
}

function assetObjectId(input: ReturnType<typeof normalizedStageInput>) {
  return `asset_object_${sha256(JSON.stringify({
    schemaVersion: ASSET_OBJECT_CONTRACT_VERSION,
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    objectVersion: input.objectVersion,
    contentSha256: input.contentSha256,
  })).slice(0, 48)}`;
}

function assetObjectLocator(input: ReturnType<typeof normalizedStageInput>) {
  return [
    "v1",
    sha256(input.tenantId).slice(0, 32),
    sha256(input.ownerActorId).slice(0, 32),
    input.sourceKind,
    sha256(input.sourceId).slice(0, 48),
    `v${input.objectVersion}`,
    `${input.contentSha256}.bin`,
  ].join("/");
}

function assetObjectRequestHash(object: AssetObjectRecord) {
  return sha256(JSON.stringify({
    schemaVersion: ASSET_OBJECT_CONTRACT_VERSION,
    objectId: object.id,
    tenantId: object.tenantId,
    ownerActorId: object.ownerActorId,
    sourceKind: object.sourceKind,
    sourceId: object.sourceId,
    objectVersion: object.objectVersion,
    storageLocator: object.storageLocator,
    contentSha256: object.contentSha256,
    byteCount: object.byteCount,
    mediaType: object.mediaType,
    visibility: object.visibility,
    sensitivity: object.sensitivity,
    permissionGrantIds: object.permissionGrantIds,
    allowedPurposeIds: object.allowedPurposeIds,
    retentionPolicyId: object.retentionPolicyId,
    retentionExpiresAt: object.retentionExpiresAt,
    executionScope: object.executionScope,
  }));
}

function assetObjectJobRequest(job: OperationJobRecord) {
  const request = job.payload.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new AssetObjectError("Asset object job request is missing.", "invalid_contract");
  }
  const record = request as Record<string, unknown>;
  const objectId = typeof record.objectId === "string" ? record.objectId : "";
  const requestHash = typeof record.requestHash === "string" ? record.requestHash : "";
  if (!objectIdPattern.test(objectId) || !sha256Pattern.test(requestHash)) {
    throw new AssetObjectError("Asset object job request is invalid.", "invalid_contract");
  }
  return { objectId, requestHash };
}

function assertAssetObjectJobBinding(
  job: OperationJobRecord,
  object: AssetObjectRecord,
  requestHash: string,
) {
  if (
    object.tenantId !== job.tenantId ||
    assetObjectRequestHash(object) !== requestHash ||
    job.payload.actorId !== object.ownerActorId
  ) {
    throw new AssetObjectError("Asset object job binding is invalid.", "invalid_contract");
  }
  const scope = parsePersistedExecutionScope(job.payload.executionScope);
  if (!scope || !executionScopesEqual(scope, object.executionScope)) {
    throw new AssetObjectError("Asset object job scope is invalid.", "invalid_contract");
  }
}

function workerExecutionScope(job: OperationJobRecord, object: AssetObjectRecord) {
  const scope = structuredClone(object.executionScope);
  return {
    ...scope,
    executingPrincipalType: "system" as const,
    executingPrincipalId: "asset-object-worker",
    causationId: job.id,
    purpose: job.type === "asset.object.delete"
      ? "asset.object.scrub"
      : "asset.object.commit",
  };
}

async function readLegacyAssetBytes(
  object: AssetObjectRecord,
  sql: ReturnType<typeof getSql>,
) {
  const rows = object.sourceKind === "capture_asset"
    ? await sql`
        SELECT content AS bytes FROM omni_capture_assets
        WHERE id = ${object.sourceId} AND tenant_id = ${object.tenantId}
          AND actor_id = ${object.ownerActorId}
        LIMIT 1
      `
    : await sql`
        SELECT audio_data AS bytes FROM omni_capture_segments
        WHERE id = ${object.sourceId} AND tenant_id = ${object.tenantId}
          AND actor_id = ${object.ownerActorId}
        LIMIT 1
      `;
  if (!rows[0]?.bytes) {
    throw new AssetObjectError("The legacy asset source is no longer current.", "source_not_current");
  }
  return new Uint8Array(Buffer.from(rows[0].bytes as Uint8Array));
}

async function assertSourceStillCurrent(
  object: AssetObjectRecord,
  sql: ReturnType<typeof getSql>,
) {
  const rows = object.sourceKind === "capture_asset"
    ? await sql`
        SELECT 1 FROM omni_capture_assets
        WHERE id = ${object.sourceId} AND tenant_id = ${object.tenantId}
          AND actor_id = ${object.ownerActorId}
        LIMIT 1
      `
    : await sql`
        SELECT 1 FROM omni_capture_segments
        WHERE id = ${object.sourceId} AND tenant_id = ${object.tenantId}
          AND actor_id = ${object.ownerActorId}
        LIMIT 1
      `;
  if (rows.length !== 1) {
    throw new AssetObjectError("The asset source is no longer current.", "source_not_current");
  }
}

function assertObjectBytes(object: AssetObjectRecord, bytes: Uint8Array) {
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== object.byteCount || checksum !== object.contentSha256) {
    throw new AssetObjectError("Asset object integrity validation failed.", "storage_integrity_failed");
  }
}

async function recordAssetObjectFailure(
  object: AssetObjectRecord,
  job: OperationJobRecord,
  failureCode: string,
) {
  const safeCode = /^[a-z0-9_]{1,80}$/.test(failureCode)
    ? failureCode
    : "storage_write_failed";
  const sql = getSql();
  await sql.transaction(async (tx: ReturnType<typeof getSql>) => {
    const rows = await tx`
      UPDATE omni_asset_objects
      SET status = CASE WHEN status = 'deleted' THEN status ELSE 'failed' END,
          failure_count = failure_count + 1,
          failure_code = ${safeCode}, updated_at = clock_timestamp()
      WHERE id = ${object.id} AND tenant_id = ${object.tenantId}
        AND owner_actor_id = ${object.ownerActorId}
      RETURNING *
    `;
    if (!rows[0]) return;
    const failed = assetObjectFromRow(rows[0]);
    await appendAssetObjectEvent(failed, workerExecutionScope(job, object), "asset_object.failed", {
      objectId: failed.id,
      sourceKind: failed.sourceKind,
      sourceIdSha256: sha256(failed.sourceId),
      objectVersion: failed.objectVersion,
      failureCode: safeCode,
      failureCount: failed.failureCount,
    }, tx);
  });
}

function assetObjectFailureCode(error: unknown) {
  return error instanceof AssetObjectError
    ? error.code
    : "storage_write_failed";
}

async function getAssetObjectById(
  id: string,
  tenantId: string,
  sql: ReturnType<typeof getSql>,
) {
  const rows = await sql`
    SELECT * FROM omni_asset_objects
    WHERE id = ${id} AND tenant_id = ${tenantId}
    LIMIT 1
  `;
  return rows[0] ? assetObjectFromRow(rows[0]) : undefined;
}

function assetObjectFromRow(row: Record<string, unknown>): AssetObjectRecord {
  const executionScope = parsePersistedExecutionScope(row.execution_scope);
  if (!executionScope) {
    throw new AssetObjectError("Stored asset object scope is invalid.", "invalid_contract");
  }
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    ownerActorId: String(row.owner_actor_id),
    workspaceId: row.workspace_id ? String(row.workspace_id) : null,
    projectId: row.project_id ? String(row.project_id) : null,
    missionId: row.mission_id ? String(row.mission_id) : null,
    sourceKind: String(row.source_kind) as AssetObjectSourceKind,
    sourceId: String(row.source_id),
    objectVersion: Number(row.object_version),
    storageProvider: String(row.storage_provider) as typeof ASSET_OBJECT_STORAGE_PROVIDER,
    storageLocator: String(row.storage_locator),
    storageEtag: row.storage_etag ? String(row.storage_etag) : null,
    status: String(row.status) as AssetObjectStatus,
    contentSha256: String(row.content_sha256),
    byteCount: Number(row.byte_count),
    mediaType: String(row.media_type),
    visibility: String(row.visibility) as "user_private",
    sensitivity: String(row.sensitivity) as AssetObjectRecord["sensitivity"],
    permissionGrantIds: Array.isArray(row.permission_grant_ids)
      ? row.permission_grant_ids.map(String)
      : [],
    allowedPurposeIds: Array.isArray(row.allowed_purpose_ids)
      ? row.allowed_purpose_ids.map(String)
      : [],
    retentionPolicyId: String(row.retention_policy_id),
    retentionExpiresAt: row.retention_expires_at
      ? new Date(String(row.retention_expires_at)).toISOString()
      : null,
    extractionState: String(row.extraction_state) as AssetObjectRecord["extractionState"],
    uploadJobId: row.upload_job_id ? String(row.upload_job_id) : null,
    failureCount: Number(row.failure_count),
    failureCode: row.failure_code ? String(row.failure_code) : null,
    executionScope,
    readyAt: row.ready_at ? new Date(String(row.ready_at)).toISOString() : null,
    deletedAt: row.deleted_at ? new Date(String(row.deleted_at)).toISOString() : null,
    scrubbedAt: row.scrubbed_at ? new Date(String(row.scrubbed_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function assertStagedObjectMatches(
  object: AssetObjectRecord,
  expected: ReturnType<typeof normalizedStageInput>,
) {
  if (
    object.tenantId !== expected.tenantId ||
    object.ownerActorId !== expected.ownerActorId ||
    object.sourceKind !== expected.sourceKind ||
    object.sourceId !== expected.sourceId ||
    object.objectVersion !== expected.objectVersion ||
    object.contentSha256 !== expected.contentSha256 ||
    object.byteCount !== expected.byteCount ||
    object.mediaType !== expected.mediaType ||
    object.workspaceId !== expected.workspaceId ||
    object.projectId !== expected.projectId ||
    object.missionId !== expected.missionId ||
    object.storageProvider !== ASSET_OBJECT_STORAGE_PROVIDER ||
    object.storageLocator !== assetObjectLocator(expected) ||
    object.visibility !== "user_private" ||
    object.sensitivity !== expected.sensitivity ||
    !stringSetsEqual(object.permissionGrantIds, expected.permissionGrantIds) ||
    !stringSetsEqual(object.allowedPurposeIds, expected.allowedPurposeIds) ||
    object.retentionPolicyId !== expected.retentionPolicyId ||
    object.retentionExpiresAt !== expected.retentionExpiresAt ||
    !executionScopesEqual(object.executionScope, expected.executionScope)
  ) {
    throw new AssetObjectError("Asset object id is bound to different metadata.", "invalid_contract");
  }
}

function appendAssetObjectEvent(
  object: AssetObjectRecord,
  executionScope: ExecutionScope,
  type: AssetObjectEventType,
  payload: Record<string, unknown>,
  sql: ReturnType<typeof getSql>,
) {
  const eventRevision = type === "asset_object.failed"
    ? String(object.failureCount)
    : type === "asset_object.extraction_changed"
      ? `${object.objectVersion}:${object.extractionState}`
      : String(object.objectVersion);
  return appendScopedDomainEvent({
    id: `asset-object:${object.id}:${type}:${eventRevision}`,
    streamId: `asset-object:${object.id}`,
    type,
    executionScope,
    payload: { schemaVersion: ASSET_OBJECT_CONTRACT_VERSION, ...payload },
  }, { sql });
}

function openDeliveryToken(token: string) {
  if (!deliveryTokenPattern.test(token)) {
    throw new AssetObjectError("Asset delivery token is invalid.", "delivery_token_invalid");
  }
  const [, encoded, signature] = token.split(".");
  const expected = createHmac("sha256", deliverySecret())
    .update(`ao1.${encoded}`, "utf8")
    .digest();
  const provided = Buffer.from(signature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new AssetObjectError("Asset delivery token is invalid.", "delivery_token_invalid");
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new AssetObjectError("Asset delivery token is invalid.", "delivery_token_invalid");
  }
  const objectId = typeof payload.objectId === "string" ? payload.objectId : "";
  const tenantSha256 = typeof payload.tenantSha256 === "string" ? payload.tenantSha256 : "";
  const actorSha256 = typeof payload.actorSha256 === "string" ? payload.actorSha256 : "";
  const purpose = typeof payload.purpose === "string" ? payload.purpose : "";
  const expiresAt = Number(payload.expiresAt);
  if (
    payload.v !== 1 ||
    !objectIdPattern.test(objectId) ||
    !sha256Pattern.test(tenantSha256) ||
    !sha256Pattern.test(actorSha256) ||
    !purpose || !Number.isSafeInteger(expiresAt)
  ) {
    throw new AssetObjectError("Asset delivery token is invalid.", "delivery_token_invalid");
  }
  if (expiresAt <= Date.now()) {
    throw new AssetObjectError("Asset delivery token has expired.", "delivery_token_expired");
  }
  return { objectId, tenantSha256, actorSha256, purpose, expiresAt };
}

function deliverySecret() {
  const dedicated = process.env.OMNIAGENT_ASSET_DELIVERY_SECRET?.trim();
  if (dedicated) {
    if (Buffer.byteLength(dedicated, "utf8") < 32) {
      throw new AssetObjectError("Asset delivery signing is not configured.", "storage_not_configured");
    }
    return Buffer.from(dedicated, "utf8");
  }
  const internal = process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim();
  if (!internal || Buffer.byteLength(internal, "utf8") < 32) {
    throw new AssetObjectError("Asset delivery signing is not configured.", "storage_not_configured");
  }
  return createHmac("sha256", internal)
    .update("asael:asset-delivery:v1", "utf8")
    .digest();
}

function requiredOwnerScope(
  value: ExecutionScope,
  tenantId: string,
  ownerActorId: string,
) {
  const scope = parsePersistedExecutionScope(value);
  if (!scope) {
    throw new AssetObjectError("Asset object execution scope is invalid.", "invalid_contract");
  }
  assertExecutionScopeTenant(scope, tenantId);
  if (scope.initiatingActorId !== ownerActorId) {
    throw new AssetObjectError("Asset object owner does not match its scope.", "invalid_contract");
  }
  return scope;
}

function requiredText(value: unknown, max: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || Array.from(normalized).length > max) {
    throw new AssetObjectError("Asset object contract contains invalid text.", "invalid_contract");
  }
  return normalized;
}

function optionalText(value: unknown, max: number) {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, max);
}

function positiveInteger(value: unknown) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new AssetObjectError("Asset object contract contains an invalid integer.", "invalid_contract");
  }
  return normalized;
}

function optionalTimestamp(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = new Date(String(value));
  if (!Number.isFinite(timestamp.getTime())) {
    throw new AssetObjectError("Asset object retention timestamp is invalid.", "invalid_contract");
  }
  return timestamp.toISOString();
}

function normalizedStringSet(values: string[], max: number) {
  return [...new Set(values.map((value) => requiredText(value, max)))].sort();
}

function normalizedExtractionState(value: unknown): AssetObjectRecord["extractionState"] {
  if (
    value !== "pending" &&
    value !== "completed" &&
    value !== "unsupported" &&
    value !== "failed"
  ) {
    throw new AssetObjectError("Asset object extraction state is invalid.", "invalid_contract");
  }
  return value;
}

function stringSetsEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
