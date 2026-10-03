import type { TrashActionPreviewV1, TrashEffectReceiptV1, TrashItemV1 } from "@/lib/trash/contracts";
import { date, digest, integer, member, object, strings, text } from "./settings-advanced-state";

export async function settingsTextSha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined || typeof value === "number" && !Number.isFinite(value)) throw new Error("Recovery metadata must contain finite JSON values.");
  return serialized;
}
export const settingsJsonSha256 = (value: unknown) => settingsTextSha256(canonicalJson(value));
async function hasDigest(value: Record<string, unknown>, key: string) {
  const { [key]: expected, ...body } = value;
  return digest(expected) && await settingsJsonSha256(body) === expected;
}
const resources = ["custom_agent", "agent_skill", "mcp_connector", "openapi_connector"] as const;
export async function readTrashItem(value: unknown): Promise<TrashItemV1> {
  if (!object(value) || value.version !== "p9.3-trash-item:1" || !text(value.trashId) || !text(value.tenantId) || !text(value.ownerActorId) ||
    !member(value.resourceType, resources) || !text(value.resourceId) || !text(value.displayLabel) || !member(value.state, ["retained", "restored", "purged", "expired"]) ||
    !integer(value.lifecycleRevision) || value.lifecycleRevision < 1 || !date(value.restoreUntil) || !date(value.trashedAt) ||
    !digest(value.targetSha256) || !digest(value.snapshotSha256) || !object(value.compensation) || !member(value.compensation.kind, ["exact_restore", "equivalent_action", "unavailable"]) ||
    !(value.compensation.limitation === null || typeof value.compensation.limitation === "string") || !(value.compensation.handlerId === null || text(value.compensation.handlerId)) ||
    value.compensation.kind === "exact_restore" && !text(value.compensation.handlerId) ||
    !(value.restoredAt === null || date(value.restoredAt)) || !(value.purgedAt === null || date(value.purgedAt)) ||
    value.state === "retained" && (value.restoredAt !== null || value.purgedAt !== null) || value.state === "restored" && (!date(value.restoredAt) || value.purgedAt !== null) ||
    (value.state === "purged" || value.state === "expired") && (!date(value.purgedAt) || value.restoredAt !== null) || Date.parse(String(value.restoreUntil)) <= Date.parse(String(value.trashedAt)) ||
    !await hasDigest(value, "itemSha256")) throw new Error("Trash returned invalid item metadata. Last-loaded items are retained.");
  return value as unknown as TrashItemV1;
}
export async function readTrashList(value: unknown) {
  if (!object(value) || !Array.isArray(value.items) || value.items.length > 100) throw new Error("Trash returned an incomplete list.");
  const items = await Promise.all(value.items.map(readTrashItem));
  if (new Set(items.map((item) => item.trashId)).size !== items.length || items.some((item) => item.state !== "retained")) throw new Error("Trash returned conflicting item identities.");
  return items;
}
export async function readTrashPreview(value: unknown, item: TrashItemV1, action: "restore" | "purge", now = Date.now()): Promise<TrashActionPreviewV1> {
  if (!object(value) || !object(value.preview)) throw new Error("The reviewed trash preview is unavailable.");
  const current = await readTrashItem(value.item);
  const preview = value.preview;
  if (current.itemSha256 !== item.itemSha256 || preview.version !== "p9.3-trash-preview:1" || preview.action !== action || preview.trashId !== item.trashId ||
    preview.resourceId !== item.resourceId || preview.resourceType !== item.resourceType || preview.lifecycleRevision !== item.lifecycleRevision || preview.targetSha256 !== item.targetSha256 ||
    !text(preview.effectSummary) || preview.reversible !== (action === "restore") || !date(preview.issuedAt) || !date(preview.expiresAt) || Date.parse(preview.expiresAt) <= now ||
    Date.parse(preview.issuedAt) > now + 60_000 || !await hasDigest(preview, "previewSha256")) throw new Error("The trash item changed or its preview expired. Refresh and review the current item.");
  return preview as unknown as TrashActionPreviewV1;
}
export async function readTrashReceipt(value: unknown, preview: TrashActionPreviewV1, reviewedItem: TrashItemV1): Promise<{ item: TrashItemV1; receipt: TrashEffectReceiptV1; restoredResourceIds?: string[]; limitation?: string }> {
  if (!object(value)) throw new Error("The recovery outcome could not be confirmed.");
  const item = await readTrashItem(value.trash);
  const receipt = preview.action === "restore" ? value.effectReceipt : value.finalDeletionReceipt;
  const finalState = preview.action === "restore" ? "restored" : "purged";
  if (!object(receipt) || receipt.version !== "p9.3-trash-effect-receipt:1" || receipt.action !== preview.action || receipt.trashId !== preview.trashId || receipt.resourceId !== preview.resourceId ||
    receipt.resourceType !== preview.resourceType || receipt.targetSha256 !== preview.targetSha256 || receipt.previewSha256 !== preview.previewSha256 ||
    !member(receipt.outcome, ["applied", "already_applied"]) || receipt.afterState !== finalState || !integer(receipt.beforeRevision) || !integer(receipt.afterRevision) ||
    receipt.beforeRevision !== preview.lifecycleRevision || receipt.afterRevision !== receipt.beforeRevision + 1 || receipt.beforeState !== "retained" || !date(receipt.occurredAt) || !strings(receipt.affectedResourceIds) ||
    item.trashId !== preview.trashId || item.resourceId !== preview.resourceId || item.state !== finalState || item.lifecycleRevision !== receipt.afterRevision ||
    item.tenantId !== reviewedItem.tenantId || item.ownerActorId !== reviewedItem.ownerActorId || item.targetSha256 !== reviewedItem.targetSha256 ||
    !await hasDigest(receipt, "receiptSha256")) throw new Error("The recovery response did not match the reviewed preview. Its outcome is unconfirmed; refresh before repeating it.");
  if (preview.action === "restore" && (!strings(value.restoredResourceIds) || !(value.limitation === undefined || value.limitation === null || typeof value.limitation === "string"))) throw new Error("The restored resource receipt is incomplete.");
  return { item, receipt: receipt as unknown as TrashEffectReceiptV1, restoredResourceIds: preview.action === "restore" && strings(value.restoredResourceIds) ? value.restoredResourceIds : undefined, limitation: typeof value.limitation === "string" ? value.limitation : undefined };
}

export function archiveContainsEncryptedAssets(value: unknown) {
  return object(value) && value.version === 2 && Boolean(value.assetEncryption) && object(value.data) && Array.isArray(value.data.assets) && value.data.assets.length > 0;
}
const sections = ["knowledge", "memories", "threads", "today", "projects", "connections", "skills", "agents", "assets"] as const;
const legacyCounts = ["knowledge", "memories", "threads", "turns", "today", "projects", "skills", "agents"] as const;
export async function readPortableRestore(value: unknown, archive: unknown, tenantId?: string) {
  if (!object(value) || !object(value.restored) || !legacyCounts.every((key) => integer((value.restored as Record<string, unknown>)[key]))) throw new Error("The restore response did not include valid counts. Its outcome is unconfirmed.");
  const restored = value.restored;
  if (!object(archive) || archive.version !== 2) return { count: legacyCounts.reduce((sum, key) => sum + Number(restored[key]), 0), verification: undefined, reauthorization: undefined };
  const receipt = restored.verification;
  if (!object(receipt) || receipt.schemaVersion !== 1 || receipt.contractId !== "asael.portable.restore.v1" || receipt.archiveSha256 !== archive.archiveSha256 ||
    !object(archive.manifest) || receipt.manifestSha256 !== archive.manifest.manifestSha256 || !object(archive.data) ||
    !["sourceOwnerActorIdSha256", "sourceTenantIdSha256", "targetOwnerActorIdSha256", "targetTenantIdSha256"].every((key) => digest(receipt[key])) ||
    !["ownershipRebound", "provenancePreserved", "archiveIntegrityVerified", "countsVerified", "hashesVerified"].every((key) => receipt[key] === true) ||
    !object(receipt.declaredCounts) || !object(receipt.restoredCounts) || !object(receipt.declaredSectionSha256) || !object(receipt.restoredInputSha256) || !date(receipt.verifiedAt) ||
    !integer(receipt.connectionsReauthorizationRequired) || receipt.connectionsReauthorizationRequired !== restored.connectionsReauthorizationRequired ||
    !await hasDigest(receipt, "receiptSha256") || !tenantId || receipt.targetTenantIdSha256 !== await settingsTextSha256(tenantId)) throw new Error("The v2 restore receipt did not match this archive and workspace. The outcome is unconfirmed.");
  for (const key of sections) {
    const records = archive.data[key];
    const declared = receipt.declaredCounts[key];
    const count = receipt.restoredCounts[key];
    if (!Array.isArray(records) || declared !== records.length || count !== (key === "connections" ? 0 : declared) || restored[key] !== count ||
      !digest(receipt.declaredSectionSha256[key]) || receipt.declaredSectionSha256[key] !== receipt.restoredInputSha256[key]) throw new Error("The restore receipt counts or section hashes do not match the selected archive.");
  }
  if (receipt.connectionsReauthorizationRequired !== receipt.declaredCounts.connections || receipt.restoredCounts.turns !== restored.turns) throw new Error("The restore receipt disposition is inconsistent.");
  return { count: legacyCounts.reduce((sum, key) => sum + Number(restored[key]), 0) + Number(restored.assets), verification: receipt, reauthorization: receipt.connectionsReauthorizationRequired };
}
