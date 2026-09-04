import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureActorReadOrder } from "@/lib/capture/actor-scope";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
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
  CaptureAsset,
  CaptureAssetStatus,
  RequestCaptureAsset,
} from "@/lib/capture/types";

type CaptureAssetLedger = {
  assets: Array<CaptureAsset & { contentPath: string }>;
};

type Owner = { tenantId: string; actorId: string };
type CaptureAssetListOwner = Owner & {
  requestActorBinding?: CanonicalRequestActorBindingV1;
};
type ScopedOwner = Owner & { executionScope: ExecutionScope };
type CaptureAssetEventPayload = {
  schemaVersion: 1;
  assetId: string;
  contentSha256?: string;
  byteCount?: number;
  status?: CaptureAssetStatus;
  previousStatus?: CaptureAssetStatus;
  extractionStatus?: CaptureAsset["extractionStatus"];
  previousExtractionStatus?: CaptureAsset["extractionStatus"];
  ingestJobId?: string;
  knowledgeDocumentId?: string;
  errorSha256?: string;
  errorByteCount?: number;
  scopeVersion?: ExecutionScope["version"];
  scopeSha256?: string;
};

const CAPTURE_ASSET_EVENT_SCHEMA_VERSION = 1 as const;
export const MAX_CAPTURE_ASSET_BYTES = 20 * 1024 * 1024;

export type InternalCaptureAssetQuery = {
  kind: string;
  scopeField: string;
  scopeValue: string;
  limit?: number;
};

export class CaptureAssetError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 413 = 400) {
    super(message);
    this.name = "CaptureAssetError";
  }
}

export class CaptureAssetReadConflictError extends Error {
  constructor(message = "Capture asset ownership is ambiguous.") {
    super(message);
    this.name = "CaptureAssetReadConflictError";
  }
}

export async function saveCaptureAsset(input: ScopedOwner & {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  tags?: string[];
  metadata?: Record<string, unknown>;
}) {
  const executionScope = requireCaptureAssetMutationScope(input);
  if (!input.bytes.byteLength) throw new CaptureAssetError("The selected file is empty.");
  if (input.bytes.byteLength > MAX_CAPTURE_ASSET_BYTES) throw new CaptureAssetError("Stored files must be 20 MB or smaller.", 413);
  const now = new Date().toISOString();
  const id = randomUUID();
  const asset: CaptureAsset = {
    id,
    tenantId: normalizeTenantId(input.tenantId),
    actorId: normalizeActorId(input.actorId),
    filename: safeFilename(input.filename),
    mediaType: normalizeMime(input.mediaType),
    extension: fileExtension(input.filename),
    byteCount: input.bytes.byteLength,
    contentSha256: createHash("sha256").update(input.bytes).digest("hex"),
    storageKind: hasDatabaseUrl() ? "database" : "filesystem",
    status: "stored",
    extractionStatus: "pending",
    tags: normalizeTags(input.tags || []),
    metadata: sanitizeMetadata(input.metadata),
    createdAt: now,
    updatedAt: now,
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
        INSERT INTO omni_capture_assets (
          id, tenant_id, actor_id, filename, media_type, extension, byte_count,
          content_sha256, storage_kind, content, status, extraction_status, tags,
          metadata, created_at, updated_at
        ) VALUES (
          ${asset.id}, ${asset.tenantId}, ${asset.actorId}, ${asset.filename},
          ${asset.mediaType}, ${asset.extension}, ${asset.byteCount},
          ${asset.contentSha256}, 'database', ${Buffer.from(input.bytes)},
          ${asset.status}, ${asset.extractionStatus}, ${asset.tags},
          ${asset.metadata}::jsonb, ${now}, ${now}
        ) RETURNING id, tenant_id, actor_id, filename, media_type, extension,
          byte_count, content_sha256, storage_kind, status, extraction_status,
          ingest_job_id, knowledge_document_id, error, tags, metadata, created_at,
          updated_at
      `;
      const saved = assetFromRow(rows[0]);
      await appendCaptureAssetEvent(saved, executionScope, "capture_asset.scope_bound", {
        schemaVersion: CAPTURE_ASSET_EVENT_SCHEMA_VERSION,
        assetId: saved.id,
        contentSha256: saved.contentSha256,
        byteCount: saved.byteCount,
        status: saved.status,
        extractionStatus: saved.extractionStatus,
        scopeVersion: executionScope.version,
        scopeSha256: sha256Json(executionScope),
      }, { sql });
      return saved;
    }) as Promise<CaptureAsset>;
  }
  const directory = getAssetDirectory(asset.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const contentPath = path.join(directory, "original.bin");
  await writeFile(contentPath, input.bytes, { mode: 0o600 });
  await updateJsonFile<CaptureAssetLedger>(getAssetLedgerFile(), { assets: [] }, (ledger) => ({
    assets: [{ ...asset, contentPath }, ...ledger.assets],
  }));
  await appendCaptureAssetEvent(asset, executionScope, "capture_asset.scope_bound", {
    schemaVersion: CAPTURE_ASSET_EVENT_SCHEMA_VERSION,
    assetId: asset.id,
    contentSha256: asset.contentSha256,
    byteCount: asset.byteCount,
    status: asset.status,
    extractionStatus: asset.extractionStatus,
    scopeVersion: executionScope.version,
    scopeSha256: sha256Json(executionScope),
  });
  return asset;
}

export async function listCaptureAssets(
  owner: CaptureAssetListOwner,
  limit = 100,
) {
  const tenantId = normalizeTenantId(owner.tenantId);
  const actorId = normalizeActorId(owner.actorId);
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const actorReadOrder = captureActorReadOrder(
      owner.actorId,
      owner.requestActorBinding,
      actorId,
    );
    const canonicalActorId = actorReadOrder[0];
    const exactActorId = actorReadOrder[1];
    const rows = await getSql()`
      SELECT id, tenant_id, actor_id, filename, media_type, extension, byte_count,
        content_sha256, storage_kind, status, extraction_status, ingest_job_id,
        knowledge_document_id, error, tags, metadata, created_at, updated_at
      FROM omni_capture_assets
      WHERE tenant_id = ${tenantId}
        AND (actor_id = ${canonicalActorId} OR actor_id = ${exactActorId})
        AND COALESCE(metadata->>'internalKind', '') = ''
      ORDER BY updated_at DESC, id ASC
      LIMIT ${boundedLimit}
    `;
    return rows.map((row) =>
      captureAssetForRequest(assetFromRow(row), exactActorId),
    );
  }
  const ledger = await readJsonFile<CaptureAssetLedger>(getAssetLedgerFile(), { assets: [] });
  return ledger.assets
    .filter((item) =>
      item.tenantId === tenantId &&
      item.actorId === actorId &&
      !optionalString(item.metadata.internalKind)
    )
    .slice(0, boundedLimit)
    .map((asset) => captureAssetForExactFileRequest(withoutContentPath(asset)));
}

export async function listInternalCaptureAssets(
  owner: Owner,
  query: InternalCaptureAssetQuery,
) {
  const tenantId = normalizeTenantId(owner.tenantId);
  const actorId = normalizeActorId(owner.actorId);
  const kind = safeMetadataLookup(query.kind, "internal kind");
  const scopeField = safeMetadataLookup(query.scopeField, "scope field");
  const scopeValue = safeText(query.scopeValue, 240);
  const boundedLimit = Math.min(Math.max(Math.round(query.limit || 100), 1), 250);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT id, tenant_id, actor_id, filename, media_type, extension, byte_count,
        content_sha256, storage_kind, status, extraction_status, ingest_job_id,
        knowledge_document_id, error, tags, metadata, created_at, updated_at
      FROM omni_capture_assets
      WHERE tenant_id = ${tenantId} AND actor_id = ${actorId}
        AND metadata->>'internalKind' = ${kind}
        AND metadata->>${scopeField} = ${scopeValue}
      ORDER BY created_at DESC LIMIT ${boundedLimit}
    `;
    return rows.map(assetFromRow);
  }
  const ledger = await readJsonFile<CaptureAssetLedger>(getAssetLedgerFile(), { assets: [] });
  return ledger.assets
    .filter((item) =>
      item.tenantId === tenantId &&
      item.actorId === actorId &&
      optionalString(item.metadata.internalKind) === kind &&
      optionalString(item.metadata[scopeField]) === scopeValue
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, boundedLimit)
    .map(withoutContentPath);
}

export async function getCaptureAsset(id: string, owner: Owner) {
  const tenantId = normalizeTenantId(owner.tenantId);
  const actorId = normalizeActorId(owner.actorId);
  const assetId = normalizeId(id);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT id, tenant_id, actor_id, filename, media_type, extension, byte_count,
        content_sha256, storage_kind, status, extraction_status, ingest_job_id,
        knowledge_document_id, error, tags, metadata, created_at, updated_at
      FROM omni_capture_assets
      WHERE id = ${assetId} AND tenant_id = ${tenantId} AND actor_id = ${actorId}
      LIMIT 1
    `;
    return rows[0] ? assetFromRow(rows[0]) : undefined;
  }
  const ledger = await readJsonFile<CaptureAssetLedger>(getAssetLedgerFile(), { assets: [] });
  const asset = ledger.assets.find((item) => item.id === assetId && item.tenantId === tenantId && item.actorId === actorId);
  return asset ? withoutContentPath(asset) : undefined;
}

/**
 * Resolve metadata for an authenticated request without widening any content
 * or mutation path. Stored bytes, indexing, status changes, and deletion must
 * continue to call the exact-owner getCaptureAsset/getCaptureAssetContent
 * helpers instead.
 */
export async function getCaptureAssetForRequest(
  id: string,
  owner: CaptureAssetListOwner,
): Promise<RequestCaptureAsset | undefined> {
  const tenantId = normalizeTenantId(owner.tenantId);
  const requestActorId = normalizeActorId(owner.actorId);
  const assetId = normalizeId(id);
  if (!hasDatabaseUrl()) {
    const asset = await getCaptureAsset(assetId, {
      tenantId,
      actorId: requestActorId,
    });
    if (!asset || optionalString(asset.metadata.internalKind)) return undefined;
    return captureAssetForExactFileRequest(asset);
  }
  const [canonicalActorId, exactActorId] = captureActorReadOrder(
    owner.actorId,
    owner.requestActorBinding,
    requestActorId,
  );
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT id, tenant_id, actor_id, filename, media_type, extension, byte_count,
      content_sha256, storage_kind, status, extraction_status, ingest_job_id,
      knowledge_document_id, error, tags, metadata, created_at, updated_at
    FROM omni_capture_assets
    WHERE id = ${assetId}
      AND tenant_id = ${tenantId}
      AND (actor_id = ${canonicalActorId} OR actor_id = ${exactActorId})
      AND COALESCE(metadata->>'internalKind', '') = ''
    LIMIT 1
  `;
  if (!rows[0]) return undefined;
  const asset = assetFromRow(rows[0]);
  assertRequestCaptureAssetOwner(
    asset,
    assetId,
    tenantId,
    canonicalActorId,
    exactActorId,
  );
  return captureAssetForRequest(asset, exactActorId);
}

/**
 * Recover the trusted owner for a Capture ingestion job created by an older
 * release. The job binding prevents arbitrary knowledge metadata from being
 * used to cross an actor boundary.
 */
export async function resolveCaptureAssetActorForIngestJob(
  id: string,
  input: { tenantId: string; ingestJobId: string },
) {
  const tenantId = normalizeTenantId(input.tenantId);
  const assetId = normalizeId(id);
  const ingestJobId = normalizeId(input.ingestJobId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT actor_id
      FROM omni_capture_assets
      WHERE id = ${assetId}
        AND tenant_id = ${tenantId}
        AND ingest_job_id = ${ingestJobId}
      LIMIT 1
    `;
    return rows[0]?.actor_id ? normalizeActorId(String(rows[0].actor_id)) : undefined;
  }
  const ledger = await readJsonFile<CaptureAssetLedger>(getAssetLedgerFile(), { assets: [] });
  const asset = ledger.assets.find((item) =>
    item.id === assetId &&
    item.tenantId === tenantId &&
    item.ingestJobId === ingestJobId
  );
  return asset?.actorId;
}

export async function getCaptureAssetContent(id: string, owner: Owner) {
  const asset = await requireCaptureAsset(id, owner);
  if (hasDatabaseUrl()) {
    const rows = await getSql()`SELECT content FROM omni_capture_assets WHERE id = ${asset.id} AND tenant_id = ${asset.tenantId} AND actor_id = ${asset.actorId} LIMIT 1`;
    if (!rows[0]) throw new CaptureAssetError("Captured file not found.", 404);
    return { asset, bytes: Buffer.from(rows[0].content as Uint8Array) };
  }
  const ledger = await readJsonFile<CaptureAssetLedger>(getAssetLedgerFile(), { assets: [] });
  const stored = ledger.assets.find((item) => item.id === asset.id && item.tenantId === asset.tenantId && item.actorId === asset.actorId);
  if (!stored) throw new CaptureAssetError("Captured file not found.", 404);
  return { asset, bytes: await readFile(stored.contentPath) };
}

export async function updateCaptureAssetStatus(id: string, owner: ScopedOwner, input: {
  status: CaptureAssetStatus;
  extractionStatus: CaptureAsset["extractionStatus"];
  ingestJobId?: string;
  knowledgeDocumentId?: string;
  error?: string;
}) {
  const executionScope = requireCaptureAssetMutationScope(owner);
  const asset = await requireCaptureAsset(id, owner);
  const now = new Date().toISOString();
  const error = safeText(input.error, 1_000);
  if (hasDatabaseUrl()) {
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
        UPDATE omni_capture_assets
        SET status = ${input.status}, extraction_status = ${input.extractionStatus},
          ingest_job_id = ${input.ingestJobId || null},
          knowledge_document_id = ${input.knowledgeDocumentId || null},
          error = ${error || null}, updated_at = ${now}
        WHERE id = ${asset.id} AND tenant_id = ${asset.tenantId} AND actor_id = ${asset.actorId}
        RETURNING id, tenant_id, actor_id, filename, media_type, extension,
          byte_count, content_sha256, storage_kind, status, extraction_status,
          ingest_job_id, knowledge_document_id, error, tags, metadata, created_at,
          updated_at
      `;
      const updated = assetFromRow(rows[0]);
      await appendCaptureAssetStatusEvent(asset, updated, executionScope, error, { sql });
      return updated;
    }) as Promise<CaptureAsset>;
  }
  const next: CaptureAsset = { ...asset, ...input, error: error || undefined, updatedAt: now };
  await updateJsonFile<CaptureAssetLedger>(getAssetLedgerFile(), { assets: [] }, (ledger) => ({
    assets: ledger.assets.map((item) => item.id === asset.id && item.actorId === asset.actorId ? { ...item, ...next, contentPath: item.contentPath } : item),
  }));
  await appendCaptureAssetStatusEvent(asset, next, executionScope, error);
  return next;
}

export async function deleteCaptureAsset(id: string, owner: ScopedOwner) {
  const executionScope = requireCaptureAssetMutationScope(owner);
  const asset = await requireCaptureAsset(id, owner);
  if (hasDatabaseUrl()) {
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`DELETE FROM omni_capture_assets WHERE id = ${asset.id} AND tenant_id = ${asset.tenantId} AND actor_id = ${asset.actorId} RETURNING id`;
      if (!rows[0]) return false;
      await appendCaptureAssetEvent(asset, executionScope, "capture_asset.deleted", {
        schemaVersion: CAPTURE_ASSET_EVENT_SCHEMA_VERSION,
        assetId: asset.id,
        contentSha256: asset.contentSha256,
        byteCount: asset.byteCount,
        previousStatus: asset.status,
        previousExtractionStatus: asset.extractionStatus,
        ingestJobId: asset.ingestJobId,
        knowledgeDocumentId: asset.knowledgeDocumentId,
      }, { sql });
      return true;
    }) as Promise<boolean>;
  }
  await updateJsonFile<CaptureAssetLedger>(getAssetLedgerFile(), { assets: [] }, (ledger) => ({
    assets: ledger.assets.filter((item) => !(item.id === asset.id && item.tenantId === asset.tenantId && item.actorId === asset.actorId)),
  }));
  await rm(getAssetDirectory(asset.id), { recursive: true, force: true }).catch(() => undefined);
  await appendCaptureAssetEvent(asset, executionScope, "capture_asset.deleted", {
    schemaVersion: CAPTURE_ASSET_EVENT_SCHEMA_VERSION,
    assetId: asset.id,
    contentSha256: asset.contentSha256,
    byteCount: asset.byteCount,
    previousStatus: asset.status,
    previousExtractionStatus: asset.extractionStatus,
    ingestJobId: asset.ingestJobId,
    knowledgeDocumentId: asset.knowledgeDocumentId,
  });
  return true;
}

async function appendCaptureAssetStatusEvent(
  previous: CaptureAsset,
  next: CaptureAsset,
  executionScope: ExecutionScope,
  error: string,
  options: { sql?: ReturnType<typeof getSql> } = {},
) {
  await appendCaptureAssetEvent(next, executionScope, "capture_asset.status_changed", {
    schemaVersion: CAPTURE_ASSET_EVENT_SCHEMA_VERSION,
    assetId: next.id,
    contentSha256: next.contentSha256,
    byteCount: next.byteCount,
    previousStatus: previous.status,
    status: next.status,
    previousExtractionStatus: previous.extractionStatus,
    extractionStatus: next.extractionStatus,
    ingestJobId: next.ingestJobId,
    knowledgeDocumentId: next.knowledgeDocumentId,
    errorSha256: error ? sha256Text(error) : undefined,
    errorByteCount: error ? Buffer.byteLength(error, "utf8") : undefined,
  }, options);
}

async function appendCaptureAssetEvent(
  asset: Pick<CaptureAsset, "id" | "tenantId" | "actorId">,
  executionScope: ExecutionScope,
  type: "capture_asset.scope_bound" | "capture_asset.status_changed" | "capture_asset.deleted",
  payload: CaptureAssetEventPayload,
  options: { sql?: ReturnType<typeof getSql> } = {},
) {
  await appendScopedDomainEvent({
    streamId: `capture-asset:${asset.id}`,
    type,
    payload,
    executionScope,
  }, options);
}

async function requireCaptureAsset(id: string, owner: Owner) {
  const asset = await getCaptureAsset(id, owner);
  if (!asset) throw new CaptureAssetError("Captured file not found.", 404);
  return asset;
}

function assetFromRow(row: Record<string, unknown>): CaptureAsset {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id),
    filename: String(row.filename), mediaType: String(row.media_type), extension: String(row.extension || ""),
    byteCount: Number(row.byte_count || 0), contentSha256: String(row.content_sha256),
    storageKind: String(row.storage_kind) as CaptureAsset["storageKind"], status: String(row.status) as CaptureAssetStatus,
    extractionStatus: String(row.extraction_status) as CaptureAsset["extractionStatus"],
    ingestJobId: optionalString(row.ingest_job_id), knowledgeDocumentId: optionalString(row.knowledge_document_id),
    error: optionalString(row.error), tags: Array.isArray(row.tags) ? row.tags.map(String) : [], metadata: record(row.metadata),
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function captureAssetForRequest(
  asset: CaptureAsset,
  requestActorId: string,
): RequestCaptureAsset {
  const exactOwner = asset.actorId === requestActorId;
  return {
    ...asset,
    actorId: requestActorId,
    contentAvailable: exactOwner,
    indexable: exactOwner,
    manageable: exactOwner,
  };
}

function captureAssetForExactFileRequest(
  asset: CaptureAsset,
): RequestCaptureAsset {
  return {
    ...asset,
    contentAvailable: true,
    indexable: true,
    manageable: true,
  };
}

function assertRequestCaptureAssetOwner(
  asset: CaptureAsset,
  requestedId: string,
  tenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  if (
    asset.id !== requestedId ||
    asset.tenantId !== tenantId ||
    (asset.actorId !== canonicalActorId && asset.actorId !== exactActorId) ||
    optionalString(asset.metadata.internalKind)
  ) {
    throw new CaptureAssetReadConflictError();
  }
}

function getAssetLedgerFile() { return getDataPath("capture-assets.json"); }
function getAssetDirectory(id: string) { return getDataPath("capture-assets", normalizeId(id)); }
function withoutContentPath(value: CaptureAssetLedger["assets"][number]): CaptureAsset { const { contentPath, ...asset } = value; void contentPath; return asset; }
function normalizeId(value: string) { const id = value.trim(); if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new CaptureAssetError("Invalid captured file id."); return id; }
function normalizeTenantId(value: string) { return value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default"; }
function normalizeActorId(value: string) {
  const actorId = value.trim();
  if (actorId.length > 256) {
    throw new Error("Capture asset actor identity exceeds 256 characters.");
  }
  return actorId || "anonymous";
}
function safeFilename(value: string) { return path.basename(safeText(value, 240).replace(/[\u0000-\u001f]/g, "")) || "untitled"; }
function normalizeMime(value: string) { return value.split(";", 1)[0].trim().toLowerCase().slice(0, 120) || "application/octet-stream"; }
function fileExtension(value: string) { return safeFilename(value).split(".").pop()?.toLowerCase().slice(0, 20) || ""; }
function normalizeTags(values: string[]) { return [...new Set(values.map((value) => safeText(value, 80).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")).filter(Boolean))].slice(0, 50); }
function sanitizeMetadata(value?: Record<string, unknown>) { return record(redactSensitive(value || {})); }
function safeText(value: unknown, limit: number) { return String(redactSensitive(String(value || ""))).trim().slice(0, limit); }
function safeMetadataLookup(value: string, label: string) { const normalized = value.trim(); if (!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(normalized)) throw new CaptureAssetError(`Invalid ${label}.`); return normalized; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function optionalString(value: unknown) { const text = String(value || "").trim(); return text || undefined; }
function sha256Text(value: string) { return createHash("sha256").update(value).digest("hex"); }
function sha256Json(value: unknown) { return sha256Text(JSON.stringify(value)); }

function requireCaptureAssetMutationScope(owner: ScopedOwner) {
  const executionScope = parsePersistedExecutionScope(owner.executionScope);
  if (!executionScope) throw new Error("Capture asset mutation requires a trusted execution scope.");
  const tenantId = normalizeTenantId(owner.tenantId);
  const actorId = normalizeActorId(owner.actorId);
  assertExecutionScopeTenant(executionScope, tenantId);
  if (executionScope.initiatingActorId !== actorId) {
    throw new Error("Capture asset execution scope does not match the authorized actor.");
  }
  if (!executionScope.executingPrincipalId) {
    throw new Error("Capture asset execution scope requires an executing principal.");
  }
  if (
    executionScope.executingPrincipalType === "user" &&
    executionScope.executingPrincipalId !== actorId
  ) {
    throw new Error("Capture asset user principal does not match the authorized actor.");
  }
  return executionScope;
}
