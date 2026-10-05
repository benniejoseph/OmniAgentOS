import type { TrashActionPreviewV1, TrashItemV1 } from "@/lib/trash/contracts";
import { date, digest, integer, member, object } from "./settings-advanced-state";
import { readTrashItem, settingsJsonSha256 } from "./settings-recovery-state";

export const exactTrashId = (value: unknown): value is string => typeof value === "string" && /^trash:[0-9a-f-]{36}$/.test(value);
const bounded = (value: unknown, max: number, empty = false): value is string => typeof value === "string" && value.length <= max &&
  (empty || value.length > 0) && value.trim() === value;
const exactKeys = (value: unknown, fields: string): value is Record<string, unknown> => object(value) &&
  Object.keys(value).length === fields.split(" ").length && fields.split(" ").every((key) => Object.hasOwn(value, key));
const instant = (value: unknown): value is string => date(value) &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value);
async function verifiedDigest(value: Record<string, unknown>, field: string) {
  const { [field]: hash, ...body } = value;
  return digest(hash) && hash === await settingsJsonSha256(body);
}
export type TrashReadAuthority = { tenantId: string; actorId: string; role: string; requestId: string };

/** This endpoint's app-service receipt binds {item}; its separately returned
 * history remains bounded metadata and is never used as restoration authority. */
export async function readExactTrashItem(value: unknown, trashId: string, authority: TrashReadAuthority): Promise<TrashItemV1> {
  if (!exactTrashId(trashId) || !bounded(authority.tenantId, 240) || !bounded(authority.actorId, 240) ||
    !member(authority.role, ["viewer", "operator", "admin", "system"]) || !bounded(authority.requestId, 256) ||
    !exactKeys(value, "item receipts serviceReceipt") || !Array.isArray(value.receipts) || value.receipts.length > 100 ||
    !exactKeys(value.item, "version trashId tenantId ownerActorId resourceType resourceId displayLabel targetSha256 snapshotSha256 compensation state lifecycleRevision trashedAt restoreUntil restoredAt purgedAt itemSha256")) {
    throw new Error("The exact Trash read returned incomplete or unexpected metadata.");
  }
  const item = await readTrashItem(value.item);
  if (item.trashId !== trashId || item.tenantId !== authority.tenantId || item.ownerActorId !== authority.actorId ||
    !bounded(item.resourceId, 240) || !bounded(item.displayLabel, 240) ||
    !exactKeys(item.compensation, "kind handlerId limitation") ||
    !(item.compensation.handlerId === null || bounded(item.compensation.handlerId, 240)) ||
    !(item.compensation.limitation === null || bounded(item.compensation.limitation, 500, true)) ||
    item.compensation.kind === "unavailable" && !item.compensation.limitation ||
    !instant(item.trashedAt) || !instant(item.restoreUntil) ||
    !(item.restoredAt === null || instant(item.restoredAt)) || !(item.purgedAt === null || instant(item.purgedAt))) {
    throw new Error("The exact Trash item does not belong to this current account and selection.");
  }
  const receiptIds = new Set<string>();
  for (const receipt of value.receipts) {
    if (!exactKeys(receipt, "version action trashId resourceType resourceId targetSha256 previewSha256 beforeState afterState beforeRevision afterRevision outcome affectedResourceIds occurredAt receiptSha256") ||
      receipt.version !== "p9.3-trash-effect-receipt:1" || !member(receipt.action, ["trash", "restore", "purge", "expire", "compensate"]) ||
      receipt.trashId !== item.trashId || receipt.resourceType !== item.resourceType || receipt.resourceId !== item.resourceId || receipt.targetSha256 !== item.targetSha256 ||
      !digest(receipt.previewSha256) || !(receipt.beforeState === null || member(receipt.beforeState, ["retained", "restored", "purged", "expired"])) ||
      !member(receipt.afterState, ["retained", "restored", "purged", "expired"]) || !integer(receipt.beforeRevision) || !integer(receipt.afterRevision) ||
      receipt.afterRevision < Math.max(1, receipt.beforeRevision) || !member(receipt.outcome, ["applied", "already_applied", "rejected"]) ||
      !Array.isArray(receipt.affectedResourceIds) || receipt.affectedResourceIds.length > 256 || !receipt.affectedResourceIds.every((id) => bounded(id, 240)) ||
      !instant(receipt.occurredAt) || !await verifiedDigest(receipt, "receiptSha256") || receiptIds.has(receipt.receiptSha256 as string)) {
      throw new Error("The exact Trash read returned invalid recovery history.");
    }
    receiptIds.add(receipt.receiptSha256 as string);
  }
  const proof = value.serviceReceipt;
  if (!exactKeys(proof, "schemaVersion receiptKind boundaryVersion operation action resourceType accessMode eventContract authoritySha256 idempotencyKeySha256 outcomeSha256 resourceCount occurredAt receiptSha256") ||
    proof.schemaVersion !== 1 || proof.receiptKind !== "app_service_receipt" || proof.boundaryVersion !== "p9.1-app-service-boundary:1" ||
    proof.operation !== "app.trash.show" || proof.action !== "read" || proof.resourceType !== "trash_item" || proof.accessMode !== "read" ||
    proof.eventContract !== "read_only:no_domain_mutation" || proof.idempotencyKeySha256 !== null || proof.resourceCount !== 1 ||
    !instant(proof.occurredAt) || proof.outcomeSha256 !== await settingsJsonSha256({ item }) ||
    proof.authoritySha256 !== await settingsJsonSha256({ boundaryVersion: "p9.1-app-service-boundary:1", tenantId: authority.tenantId,
      actorId: authority.actorId, role: authority.role, executionScope: {
        version: 1, tenantId: authority.tenantId, initiatingActorId: authority.actorId, executingPrincipalType: "user", executingPrincipalId: authority.actorId,
        workspaceId: null, projectId: null, missionId: null, delegationId: null, correlationId: authority.requestId, causationId: trashId,
        contextGrantIds: [], capabilityGrantIds: [], purpose: "trash.show",
      } }) || !await verifiedDigest(proof, "receiptSha256")) {
    throw new Error("The exact Trash read could not be verified for this current account and request.");
  }
  return item;
}

/** Local selection epochs complement the shared authority/read gate. Changing
 * the selected ID or closing a review fences callbacks even without a fetch. */
export function createTrashSelection() {
  let epoch = 0, mounted = true;
  return {
    mount() { mounted = true; },
    invalidate() { epoch++; },
    dispose() { mounted = false; epoch++; },
    capture() { const selected = epoch; return () => mounted && selected === epoch; },
  };
}

export type TrashRecoveryReview = { item: TrashItemV1; preview: TrashActionPreviewV1; source: "list" | "exact" };
export function trashReviewMatches(review: Pick<TrashRecoveryReview, "item" | "source">, state: {
  items?: readonly TrashItemV1[]; listFresh: boolean; listLoading: boolean;
  exactItem?: TrashItemV1; exactFresh: boolean; exactLoading: boolean; exactCurrent?: () => boolean;
}) {
  const current = review.source === "exact" ? state.exactFresh && state.exactCurrent?.() === true && !state.exactLoading && state.exactItem
    : state.listFresh && !state.listLoading && state.items?.find((item) => item.trashId === review.item.trashId);
  return Boolean(current && current.state === "retained" && current.trashId === review.item.trashId &&
    current.itemSha256 === review.item.itemSha256 && current.tenantId === review.item.tenantId && current.ownerActorId === review.item.ownerActorId);
}
