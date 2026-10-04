import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { memoryContentDigest } from "@/lib/memory/content-digest";
import { memoryReconciliationDecisionSchema, memoryReconciliationKindSchema } from "@/lib/memory/reconciliation";

export const MEMORY_RECONCILIATION_NATIVE_CONTRACT = "asael-memory-reconciliation-decision:1" as const;
export const memoryReconciliationNativeIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const tenant = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const actor = z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);

export const memoryReconciliationNativeTargetSchema = z.object({
  memoryId: memoryReconciliationNativeIdSchema,
  claimStatus: z.enum(["active", "candidate", "superseded", "contradicted"]),
  targetRevision: revision.min(1),
  lifecycleRevision: revision,
}).strict();

const targets = z.object({
  candidate: memoryReconciliationNativeTargetSchema,
  existing: memoryReconciliationNativeTargetSchema.nullable(),
}).strict();

export const memoryReconciliationNativeIdentitySchema = z.object({
  tenantId: tenant,
  ownerActorId: actor,
  reviewId: memoryReconciliationNativeIdSchema,
  kind: memoryReconciliationKindSchema,
  status: z.literal("pending"),
  targets,
}).strict();

export const memoryReconciliationNativeRequestSchema = z.object({
  contract: z.literal(MEMORY_RECONCILIATION_NATIVE_CONTRACT),
  reviewId: memoryReconciliationNativeIdSchema,
  decision: memoryReconciliationDecisionSchema,
  expectedReviewToken: digest,
}).strict();

export const memoryReconciliationNativeAcceptanceSchema = z.object({
  contract: z.literal("asael-memory-reconciliation-acceptance:1"),
  id: z.string().regex(/^memory-reconciliation-acceptance:[a-f0-9]{64}$/),
  tenantId: tenant,
  ownerActorId: actor,
  reviewId: memoryReconciliationNativeIdSchema,
  candidateMemoryId: memoryReconciliationNativeIdSchema,
  existingMemoryId: memoryReconciliationNativeIdSchema.nullable(),
  decision: memoryReconciliationDecisionSchema,
  idempotencyKeySha256: digest,
  requestSha256: digest,
  expectedReviewToken: digest,
  resolvedAt: z.string().datetime({ offset: true }),
  before: targets,
  after: targets,
}).strict().superRefine((value, context) => {
  if (value.before.candidate.memoryId !== value.candidateMemoryId ||
    value.after.candidate.memoryId !== value.candidateMemoryId ||
    (value.before.existing?.memoryId ?? null) !== value.existingMemoryId ||
    (value.after.existing?.memoryId ?? null) !== value.existingMemoryId ||
    value.before.candidate.claimStatus !== "candidate" ||
    value.after.candidate.targetRevision !== value.before.candidate.targetRevision + 1 ||
    value.after.candidate.lifecycleRevision !== value.before.candidate.lifecycleRevision ||
    value.before.existing?.claimStatus === "candidate" ||
    (value.before.existing !== null && value.before.existing.claimStatus !== "active")) {
    context.addIssue({ code: "custom", message: "Reconciliation acceptance targets are inconsistent." });
  }
  const candidateStatus = value.decision === "keep_existing" ? "superseded" : "active";
  const existingStatus = value.decision === "confirm_candidate" ? "contradicted" : "active";
  if (value.after.candidate.claimStatus !== candidateStatus ||
    (!value.existingMemoryId && value.decision === "keep_both") ||
    (value.before.existing && value.after.existing && (
      value.after.existing.claimStatus !== existingStatus ||
      value.after.existing.targetRevision !== value.before.existing.targetRevision + (existingStatus === "contradicted" ? 1 : 0) ||
      value.after.existing.lifecycleRevision !== value.before.existing.lifecycleRevision
    ))) {
    context.addIssue({ code: "custom", message: "Reconciliation acceptance does not match its decision." });
  }
});

export type MemoryReconciliationNativeRequest = z.infer<typeof memoryReconciliationNativeRequestSchema>;
export type MemoryReconciliationNativeAcceptance = z.infer<typeof memoryReconciliationNativeAcceptanceSchema>;
export type MemoryReconciliationNativeIdentity = z.infer<typeof memoryReconciliationNativeIdentitySchema>;
export type MemoryReconciliationNativeTargets = z.infer<typeof targets>;

export class MemoryReconciliationNativeError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = "MemoryReconciliationNativeError";
  }
}

export function memoryReconciliationNativeToken(input: MemoryReconciliationNativeIdentity) {
  const value = memoryReconciliationNativeIdentitySchema.parse(input);
  return memoryContentDigest(value.tenantId, JSON.stringify(["memory-reconciliation-target:1", value]));
}

export function memoryReconciliationNativeTokensEqual(left: string, right: string) {
  return digest.safeParse(left).success && digest.safeParse(right).success &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function memoryReconciliationNativeIntent(input: {
  tenantId: string; ownerActorId: string; reviewId: string;
  idempotencyKey: string; request: MemoryReconciliationNativeRequest;
}) {
  tenant.parse(input.tenantId); actor.parse(input.ownerActorId); memoryReconciliationNativeIdSchema.parse(input.reviewId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(input.idempotencyKey)) {
    throw new MemoryReconciliationNativeError("memory_reconciliation_key_invalid", 400, "A valid Idempotency-Key is required.");
  }
  const request = memoryReconciliationNativeRequestSchema.parse(input.request);
  if (request.reviewId !== input.reviewId) {
    throw new MemoryReconciliationNativeError("memory_reconciliation_review_mismatch", 400, "The request must name the exact review.");
  }
  const keySha256 = createHash("sha256").update(input.idempotencyKey).digest("hex");
  const requestSha256 = memoryContentDigest(input.tenantId, JSON.stringify([
    MEMORY_RECONCILIATION_NATIVE_CONTRACT, input.ownerActorId, input.reviewId, request.decision, request.expectedReviewToken,
  ]));
  const acceptanceId = `memory-reconciliation-acceptance:${createHash("sha256").update(JSON.stringify([
    "memory-reconciliation-acceptance:1", input.tenantId, input.ownerActorId, keySha256,
  ])).digest("hex")}`;
  return { request, keySha256, requestSha256, acceptanceId };
}
