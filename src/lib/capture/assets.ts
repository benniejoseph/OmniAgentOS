import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { redactSensitive } from "@/lib/security/context";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import type { CaptureAsset, CaptureAssetStatus } from "@/lib/capture/types";

type CaptureAssetLedger = {
  assets: Array<CaptureAsset & { contentPath: string }>;
};

type Owner = { tenantId: string; actorId: string };
export const MAX_CAPTURE_ASSET_BYTES = 20 * 1024 * 1024;

export class CaptureAssetError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 413 = 400) {
    super(message);
    this.name = "CaptureAssetError";
  }
}

export async function saveCaptureAsset(input: Owner & {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  tags?: string[];
  metadata?: Record<string, unknown>;
}) {
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
    const rows = await getSql()`
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
    return assetFromRow(rows[0]);
  }
  const directory = getAssetDirectory(asset.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const contentPath = path.join(directory, "original.bin");
  await writeFile(contentPath, input.bytes, { mode: 0o600 });
  await updateJsonFile<CaptureAssetLedger>(getAssetLedgerFile(), { assets: [] }, (ledger) => ({
    assets: [{ ...asset, contentPath }, ...ledger.assets],
  }));
  return asset;
}

export async function listCaptureAssets(owner: Owner, limit = 100) {
  const tenantId = normalizeTenantId(owner.tenantId);
  const actorId = normalizeActorId(owner.actorId);
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT id, tenant_id, actor_id, filename, media_type, extension, byte_count,
        content_sha256, storage_kind, status, extraction_status, ingest_job_id,
        knowledge_document_id, error, tags, metadata, created_at, updated_at
      FROM omni_capture_assets
      WHERE tenant_id = ${tenantId} AND actor_id = ${actorId}
      ORDER BY updated_at DESC LIMIT ${boundedLimit}
    `;
    return rows.map(assetFromRow);
  }
  const ledger = await readJsonFile<CaptureAssetLedger>(getAssetLedgerFile(), { assets: [] });
  return ledger.assets.filter((item) => item.tenantId === tenantId && item.actorId === actorId).slice(0, boundedLimit).map(withoutContentPath);
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

export async function updateCaptureAssetStatus(id: string, owner: Owner, input: {
  status: CaptureAssetStatus;
  extractionStatus: CaptureAsset["extractionStatus"];
  ingestJobId?: string;
  knowledgeDocumentId?: string;
  error?: string;
}) {
  const asset = await requireCaptureAsset(id, owner);
  const now = new Date().toISOString();
  const error = safeText(input.error, 1_000);
  if (hasDatabaseUrl()) {
    const rows = await getSql()`
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
    return assetFromRow(rows[0]);
  }
  const next: CaptureAsset = { ...asset, ...input, error: error || undefined, updatedAt: now };
  await updateJsonFile<CaptureAssetLedger>(getAssetLedgerFile(), { assets: [] }, (ledger) => ({
    assets: ledger.assets.map((item) => item.id === asset.id && item.actorId === asset.actorId ? { ...item, ...next, contentPath: item.contentPath } : item),
  }));
  return next;
}

export async function deleteCaptureAsset(id: string, owner: Owner) {
  const asset = await requireCaptureAsset(id, owner);
  if (hasDatabaseUrl()) {
    const rows = await getSql()`DELETE FROM omni_capture_assets WHERE id = ${asset.id} AND tenant_id = ${asset.tenantId} AND actor_id = ${asset.actorId} RETURNING id`;
    return Boolean(rows[0]);
  }
  await updateJsonFile<CaptureAssetLedger>(getAssetLedgerFile(), { assets: [] }, (ledger) => ({
    assets: ledger.assets.filter((item) => !(item.id === asset.id && item.tenantId === asset.tenantId && item.actorId === asset.actorId)),
  }));
  await rm(getAssetDirectory(asset.id), { recursive: true, force: true }).catch(() => undefined);
  return true;
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

function getAssetLedgerFile() { return getDataPath("capture-assets.json"); }
function getAssetDirectory(id: string) { return getDataPath("capture-assets", normalizeId(id)); }
function withoutContentPath(value: CaptureAssetLedger["assets"][number]): CaptureAsset { const { contentPath: _contentPath, ...asset } = value; return asset; }
function normalizeId(value: string) { const id = value.trim(); if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new CaptureAssetError("Invalid captured file id."); return id; }
function normalizeTenantId(value: string) { return value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default"; }
function normalizeActorId(value: string) { return value.trim().slice(0, 240) || "anonymous"; }
function safeFilename(value: string) { return path.basename(safeText(value, 240).replace(/[\u0000-\u001f]/g, "")) || "untitled"; }
function normalizeMime(value: string) { return value.split(";", 1)[0].trim().toLowerCase().slice(0, 120) || "application/octet-stream"; }
function fileExtension(value: string) { return safeFilename(value).split(".").pop()?.toLowerCase().slice(0, 20) || ""; }
function normalizeTags(values: string[]) { return [...new Set(values.map((value) => safeText(value, 80).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")).filter(Boolean))].slice(0, 50); }
function sanitizeMetadata(value?: Record<string, unknown>) { return record(redactSensitive(value || {})); }
function safeText(value: unknown, limit: number) { return String(redactSensitive(String(value || ""))).trim().slice(0, limit); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function optionalString(value: unknown) { const text = String(value || "").trim(); return text || undefined; }
