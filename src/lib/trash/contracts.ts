import { z } from "zod";

import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const TRASH_ITEM_CONTRACT_VERSION = "p9.3-trash-item:1" as const;
export const TRASH_PREVIEW_CONTRACT_VERSION = "p9.3-trash-preview:1" as const;
export const TRASH_EFFECT_RECEIPT_VERSION = "p9.3-trash-effect-receipt:1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const opaqueIdSchema = z.string().trim().min(1).max(240);

export const trashResourceTypeSchema = z.enum([
  "custom_agent",
  "agent_skill",
  "mcp_connector",
  "openapi_connector",
]);
export const trashItemStateSchema = z.enum(["retained", "restored", "purged", "expired"]);
export const compensationKindSchema = z.enum(["exact_restore", "equivalent_action", "unavailable"]);

const compensationPlanSchema = z.object({
  kind: compensationKindSchema,
  handlerId: opaqueIdSchema.nullable(),
  limitation: z.string().trim().max(500).nullable(),
}).strict().superRefine((value, refinement) => {
  if (value.kind === "exact_restore" && !value.handlerId) {
    refinement.addIssue({ code: "custom", path: ["handlerId"], message: "Exact restore requires a handler." });
  }
  if (value.kind === "unavailable" && !value.limitation) {
    refinement.addIssue({ code: "custom", path: ["limitation"], message: "Unavailable compensation requires a limitation." });
  }
});

const trashItemBodySchema = z.object({
  version: z.literal(TRASH_ITEM_CONTRACT_VERSION),
  trashId: z.string().regex(/^trash:[0-9a-f-]{36}$/),
  tenantId: opaqueIdSchema,
  ownerActorId: opaqueIdSchema,
  resourceType: trashResourceTypeSchema,
  resourceId: opaqueIdSchema,
  displayLabel: z.string().trim().min(1).max(240),
  targetSha256: sha256Schema,
  snapshotSha256: sha256Schema,
  compensation: compensationPlanSchema,
  state: trashItemStateSchema,
  lifecycleRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  trashedAt: timestampSchema,
  restoreUntil: timestampSchema,
  restoredAt: timestampSchema.nullable(),
  purgedAt: timestampSchema.nullable(),
}).strict();

export const trashItemV1Schema = trashItemBodySchema.extend({
  itemSha256: sha256Schema,
}).strict().superRefine((value, refinement) => {
  const { itemSha256, ...body } = value;
  if (itemSha256 !== canonicalJsonSha256(body)) {
    refinement.addIssue({ code: "custom", path: ["itemSha256"], message: "Trash item digest does not match." });
  }
  const terminalTimeValid = value.state === "restored"
    ? Boolean(value.restoredAt) && !value.purgedAt
    : value.state === "purged" || value.state === "expired"
      ? Boolean(value.purgedAt) && !value.restoredAt
      : !value.restoredAt && !value.purgedAt;
  if (!terminalTimeValid) {
    refinement.addIssue({ code: "custom", path: ["state"], message: "Trash lifecycle timestamps do not match state." });
  }
  if (Date.parse(value.restoreUntil) <= Date.parse(value.trashedAt)) {
    refinement.addIssue({ code: "custom", path: ["restoreUntil"], message: "Restore window must follow trash time." });
  }
});

const trashPreviewBodySchema = z.object({
  version: z.literal(TRASH_PREVIEW_CONTRACT_VERSION),
  action: z.enum(["trash", "restore", "purge"]),
  trashId: z.string().regex(/^trash:[0-9a-f-]{36}$/).nullable(),
  resourceType: trashResourceTypeSchema,
  resourceId: opaqueIdSchema,
  lifecycleRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  targetSha256: sha256Schema,
  effectSummary: z.string().trim().min(1).max(500),
  reversible: z.boolean(),
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
}).strict();

export const trashActionPreviewV1Schema = trashPreviewBodySchema.extend({
  previewSha256: sha256Schema,
}).strict().superRefine((value, refinement) => {
  const { previewSha256, ...body } = value;
  if (previewSha256 !== canonicalJsonSha256(body)) {
    refinement.addIssue({ code: "custom", path: ["previewSha256"], message: "Trash preview digest does not match." });
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    refinement.addIssue({ code: "custom", path: ["expiresAt"], message: "Trash preview must expire after issue time." });
  }
  if (value.action === "trash" && value.trashId !== null) {
    refinement.addIssue({ code: "custom", path: ["trashId"], message: "Pre-trash previews cannot claim a trash ID." });
  }
  if (value.action !== "trash" && value.trashId === null) {
    refinement.addIssue({ code: "custom", path: ["trashId"], message: "Restore and purge previews require a trash ID." });
  }
});

const trashEffectReceiptBodySchema = z.object({
  version: z.literal(TRASH_EFFECT_RECEIPT_VERSION),
  action: z.enum(["trash", "restore", "purge", "compensate"]),
  trashId: z.string().regex(/^trash:[0-9a-f-]{36}$/),
  resourceType: trashResourceTypeSchema,
  resourceId: opaqueIdSchema,
  targetSha256: sha256Schema,
  previewSha256: sha256Schema,
  beforeState: trashItemStateSchema.nullable(),
  afterState: trashItemStateSchema,
  beforeRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  afterRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  outcome: z.enum(["applied", "already_applied", "rejected"]),
  affectedResourceIds: z.array(opaqueIdSchema).max(256),
  occurredAt: timestampSchema,
}).strict();

export const trashEffectReceiptV1Schema = trashEffectReceiptBodySchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((value, refinement) => {
  const { receiptSha256, ...body } = value;
  if (receiptSha256 !== canonicalJsonSha256(body)) {
    refinement.addIssue({ code: "custom", path: ["receiptSha256"], message: "Trash effect receipt digest does not match." });
  }
  if (value.afterRevision < Math.max(1, value.beforeRevision)) {
    refinement.addIssue({ code: "custom", path: ["afterRevision"], message: "Trash lifecycle revision cannot move backward." });
  }
});

export type TrashItemV1 = Readonly<z.infer<typeof trashItemV1Schema>>;
export type TrashActionPreviewV1 = Readonly<z.infer<typeof trashActionPreviewV1Schema>>;
export type TrashEffectReceiptV1 = Readonly<z.infer<typeof trashEffectReceiptV1Schema>>;
export type TrashResourceType = z.infer<typeof trashResourceTypeSchema>;

export function buildTrashItemV1(input: z.input<typeof trashItemBodySchema>): TrashItemV1 {
  const body = trashItemBodySchema.parse(input);
  return trashItemV1Schema.parse({ ...body, itemSha256: canonicalJsonSha256(body) });
}

export function buildTrashActionPreviewV1(input: z.input<typeof trashPreviewBodySchema>): TrashActionPreviewV1 {
  const body = trashPreviewBodySchema.parse(input);
  return trashActionPreviewV1Schema.parse({ ...body, previewSha256: canonicalJsonSha256(body) });
}

export function buildTrashEffectReceiptV1(input: z.input<typeof trashEffectReceiptBodySchema>): TrashEffectReceiptV1 {
  const body = trashEffectReceiptBodySchema.parse(input);
  return trashEffectReceiptV1Schema.parse({ ...body, receiptSha256: canonicalJsonSha256(body) });
}
