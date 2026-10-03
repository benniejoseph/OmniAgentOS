import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  digestSchema, instantSchema, responsibilityMutationSchema, responsibilityRecordSchema,
  type ResponsibilityDraft, type ResponsibilityMutation, type ResponsibilityPins,
  sourceKey, type ResponsibilityPreview, type ResponsibilityRecord,
} from "./contracts";

export class ResponsibilityError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 503, readonly code: string) { super(message); this.name = "ResponsibilityError"; }
}
export const responsibilityReceiptSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^responsibility-mutation:[a-f0-9]{64}$/),
  idempotencySha256: digestSchema, requestSha256: digestSchema,
  action: z.enum(["created", "updated", "reviewed"]), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  snapshot: responsibilityRecordSchema, savedAt: instantSchema,
  authorityEffect: z.literal("none"), activationSupported: z.literal(false),
}).strict().refine((value) => value.snapshot.revision === value.expectedRevision + 1 && value.savedAt === value.snapshot.updatedAt);
export type ResponsibilityReceipt = z.infer<typeof responsibilityReceiptSchema>;
export type ResponsibilityOwner = { tenantId: string; actorId: string };
export type ResponsibilityChangeResult = { current: ResponsibilityRecord; receipt: ResponsibilityReceipt; replayed: boolean };
export const draftSha256 = (draft: ResponsibilityDraft) => canonicalJsonSha256({ contract: "responsibility-draft:1", draft });
export function idempotencySha256(key: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(key)) throw new ResponsibilityError("An opaque Idempotency-Key is required.", 400, "responsibility_idempotency_invalid");
  return canonicalJsonSha256(["responsibility-idempotency:1", key]);
}
export function responsibilityId(owner: ResponsibilityOwner, key: string) { return `responsibility:${canonicalJsonSha256([owner.tenantId, owner.actorId, idempotencySha256(key)])}`; }
export function requestSha256(id: string, input: ResponsibilityMutation) { return canonicalJsonSha256(["responsibility-request:1", id, responsibilityMutationSchema.parse(input)]); }
export function reviewPreview(record: ResponsibilityRecord, pins: ResponsibilityPins): ResponsibilityPreview {
  if (pins.sources.length !== record.draft.sources.length || pins.sources.some((pin, index) => sourceKey(pin.source) !== sourceKey(record.draft.sources[index])) ||
    canonicalJsonSha256({ workspaceId: pins.work.workspaceId, projectId: pins.work.projectId, workItemId: pins.work.workItemId }) !== canonicalJsonSha256(record.draft.work) ||
    pins.procedure.id !== record.draft.procedureId || pins.agent.id !== record.draft.agentId) throw storageInvalid();
  return { state: "ready", draftSha256: record.draftSha256, pins, reviewSha256: canonicalJsonSha256({
    contract: "responsibility-review:1", id: record.id, tenantId: record.tenantId, actorId: record.actorId,
    revision: record.revision, draftSha256: record.draftSha256, pins, authorityEffect: "none", activationSupported: false,
  }), authorityEffect: "none", activationSupported: false };
}
export function incompleteDraft(draft: ResponsibilityDraft, now: string) {
  const issues: string[] = [];
  if (draft.purpose.length < 3) issues.push("purpose_required");
  if (!draft.desiredOutcome) issues.push("outcome_required");
  if (!draft.sources.length) issues.push("sources_required");
  if (!draft.cadence) issues.push("cadence_required");
  else if (Date.parse(draft.cadence.expiresAt) <= Date.parse(now)) issues.push("expired");
  if (!draft.limits) issues.push("limits_required");
  if (!draft.notificationRule) issues.push("notification_rule_required");
  if (!draft.successCondition) issues.push("success_condition_required");
  if (!draft.stopConditions.length) issues.push("stop_conditions_required");
  if (!draft.work) issues.push("canonical_work_required");
  if (!draft.procedureId) issues.push("procedure_required");
  if (!draft.agentId) issues.push("agent_required");
  return issues;
}

export function verifiedRecord(value: unknown): ResponsibilityRecord {
  const parsed = responsibilityRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.draftSha256 !== draftSha256(parsed.data.draft)) throw storageInvalid();
  const record = parsed.data;
  if (record.review) {
    // Review consumes a revision but pins the immediately preceding draft.
    const preview = reviewPreview({ ...record, revision: record.revision - 1 }, record.review.pins);
    if (record.review.draftSha256 !== record.draftSha256 || record.review.reviewSha256 !== preview.reviewSha256 || record.review.reviewedAt !== record.updatedAt) throw storageInvalid();
  }
  return record;
}
export function verifiedReceipt(value: unknown): ResponsibilityReceipt {
  const parsed = responsibilityReceiptSchema.safeParse(value);
  if (!parsed.success) throw storageInvalid();
  verifiedRecord(parsed.data.snapshot);
  const receipt = parsed.data;
  if (receipt.id !== receiptId(receipt.snapshot, receipt.idempotencySha256) ||
    (receipt.action === "created") !== (receipt.expectedRevision === 0) ||
    (receipt.action === "reviewed") !== (receipt.snapshot.state === "reviewed")) throw storageInvalid();
  return receipt;
}

/** Pure admission under the store lock. A replay returns its old receipt alongside the current head. */
export function prepareResponsibilityChange(input: {
  owner: ResponsibilityOwner; id: string; mutation: ResponsibilityMutation; key: string; now: string;
  current?: ResponsibilityRecord; existing?: ResponsibilityReceipt; preview?: ResponsibilityPreview;
}): ResponsibilityChangeResult {
  const { owner, id, key, now, preview } = input;
  const mutation = responsibilityMutationSchema.parse(input.mutation);
  const current = input.current && verifiedRecord(input.current);
  const existing = input.existing && verifiedReceipt(input.existing);
  const keySha = idempotencySha256(key);
  const requestSha = requestSha256(id, mutation);
  if (current && (current.id !== id || current.tenantId !== owner.tenantId || current.actorId !== owner.actorId)) throw storageInvalid();
  if (existing) {
    if (existing.requestSha256 !== requestSha || existing.idempotencySha256 !== keySha) throw new ResponsibilityError("This Idempotency-Key belongs to another draft change.", 409, "responsibility_idempotency_conflict");
    if (!current || existing.snapshot.id !== id || existing.snapshot.tenantId !== owner.tenantId || existing.snapshot.actorId !== owner.actorId ||
      current.revision < existing.snapshot.revision || (current.revision === existing.snapshot.revision && canonicalJsonSha256(current) !== canonicalJsonSha256(existing.snapshot))) throw storageInvalid();
    return { current, receipt: existing, replayed: true };
  }
  if (mutation.action !== "create" && !current) throw notFound();
  if ((current?.revision ?? 0) !== mutation.expectedRevision) throw new ResponsibilityError("The responsibility changed. Reload its current draft.", 409, "responsibility_revision_conflict");
  if (mutation.action === "create" && id !== responsibilityId(owner, key)) throw storageInvalid();
  const draft = mutation.action === "review" ? current!.draft : mutation.draft;
  if (mutation.action === "review") {
    if (!preview || incompleteDraft(draft, now).length || preview.draftSha256 !== current!.draftSha256 ||
      preview.reviewSha256 !== reviewPreview(current!, preview.pins).reviewSha256 || mutation.draftSha256 !== preview.draftSha256 || mutation.reviewSha256 !== preview.reviewSha256) {
      throw new ResponsibilityError("The exact responsibility review changed or is incomplete. Request a fresh review.", 409, "responsibility_review_changed");
    }
  }
  const record = verifiedRecord({ schemaVersion: 1, id, ...owner, revision: mutation.expectedRevision + 1,
    state: mutation.action === "review" ? "reviewed" : "draft", draft, draftSha256: draftSha256(draft),
    review: mutation.action === "review" ? { schemaVersion: 1, draftSha256: preview!.draftSha256, reviewSha256: preview!.reviewSha256, pins: preview!.pins, reviewedAt: now, authorityEffect: "none", activationSupported: false } : null,
    createdAt: current?.createdAt ?? now, updatedAt: now });
  const receipt = verifiedReceipt({ schemaVersion: 1, id: receiptId(record, keySha), idempotencySha256: keySha, requestSha256: requestSha,
    action: mutation.action === "create" ? "created" : mutation.action === "update" ? "updated" : "reviewed",
    expectedRevision: mutation.expectedRevision, snapshot: record, savedAt: now, authorityEffect: "none", activationSupported: false });
  return { current: record, receipt, replayed: false };
}
function receiptId(owner: ResponsibilityOwner, keySha: string) { return `responsibility-mutation:${canonicalJsonSha256([owner.tenantId, owner.actorId, keySha])}`; }
export function storageInvalid() { return new ResponsibilityError("Stored responsibility evidence could not be verified.", 503, "responsibility_storage_invalid"); }
export function notFound() { return new ResponsibilityError("The responsibility is unavailable to this account.", 404, "responsibility_not_found"); }
