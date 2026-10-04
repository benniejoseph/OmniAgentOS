import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { memoryContentDigest } from "@/lib/memory/content-digest";
import { memoryLifecyclePolicyV1, memoryPromotedRecordId, memoryPromotionDecisionSchema } from "@/lib/memory/lifecycle";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const MEMORY_PROMOTION_NATIVE_DECISION_CONTRACT = "asael-memory-promotion-decision:1" as const;
export const MEMORY_PROMOTION_NATIVE_ACCEPTANCE_CONTRACT = "asael-memory-promotion-acceptance:1" as const;
export const MEMORY_PROMOTION_NATIVE_POLICY_SHA256 = canonicalJsonSha256(memoryLifecyclePolicyV1);
export const memoryPromotionNativeIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const tenantSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const ownerSchema = z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);

export const memoryPromotionNativeSourceTargetSchema = z.object({
  memoryId: memoryPromotionNativeIdSchema,
  claimStatus: z.enum(["active", "candidate", "superseded", "contradicted"]),
  targetRevision: revisionSchema.min(1),
  lifecycleRevision: revisionSchema,
  sourcePolicySha256: digestSchema,
}).strict();
export const memoryPromotionNativeSourceTargetsSchema = z.array(memoryPromotionNativeSourceTargetSchema).min(2).max(50)
  .refine((targets) => targets.every((target, index) => index === 0 || targets[index - 1].memoryId < target.memoryId), {
    message: "Promotion sources must be sorted and unique.",
  });
export const memoryPromotionNativeRequestSchema = z.object({
  contract: z.literal(MEMORY_PROMOTION_NATIVE_DECISION_CONTRACT),
  reviewId: memoryPromotionNativeIdSchema,
  decision: memoryPromotionDecisionSchema,
  expectedReviewToken: digestSchema,
  expectedPolicySha256: digestSchema,
  expectedSourceManifestSha256: digestSchema,
}).strict();

export const memoryPromotionNativeAcceptanceSchema = z.object({
  contract: z.literal(MEMORY_PROMOTION_NATIVE_ACCEPTANCE_CONTRACT),
  id: z.string().regex(/^memory-promotion-acceptance:[a-f0-9]{64}$/),
  tenantId: tenantSchema,
  ownerActorId: ownerSchema,
  reviewId: memoryPromotionNativeIdSchema,
  canonicalMemoryId: memoryPromotionNativeIdSchema,
  decision: memoryPromotionDecisionSchema,
  idempotencyKeySha256: digestSchema,
  requestSha256: digestSchema,
  expectedReviewToken: digestSchema,
  policySha256: digestSchema,
  sourceManifestSha256: digestSchema,
  sourceTargets: memoryPromotionNativeSourceTargetsSchema,
  promotedMemoryId: memoryPromotionNativeIdSchema.nullable(),
  promotedTargetRevision: revisionSchema.min(1).nullable(),
  resolvedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (!value.sourceTargets.some((target) => target.memoryId === value.canonicalMemoryId) ||
    value.sourceManifestSha256 !== canonicalJsonSha256(value.sourceTargets) ||
    value.id !== memoryPromotionNativeAcceptanceId(value.tenantId, value.ownerActorId, value.idempotencyKeySha256) ||
    (value.decision === "promote"
      ? value.promotedMemoryId !== memoryPromotedRecordId(value.reviewId) || value.promotedTargetRevision !== 1 ||
        value.sourceTargets.some((target) => target.memoryId === value.promotedMemoryId) ||
        value.sourceTargets.some((target) => target.claimStatus !== "active")
      : value.promotedMemoryId !== null || value.promotedTargetRevision !== null)) {
    context.addIssue({ code: "custom", message: "Promotion acceptance does not match its exact decision and source manifest." });
  }
});

export const memoryPromotionNativeStoredIntentSchema = z.object({
  schemaVersion: z.literal(1),
  tenantId: tenantSchema,
  ownerActorId: ownerSchema,
  idempotencyKeySha256: digestSchema,
  requestSha256: digestSchema,
  request: memoryPromotionNativeRequestSchema,
}).strict();
export const memoryPromotionNativeStoredDecisionSchema = z.object({
  intent: memoryPromotionNativeStoredIntentSchema,
  acceptance: memoryPromotionNativeAcceptanceSchema,
}).strict().superRefine(({ intent, acceptance }, context) => {
  if (intent.tenantId !== acceptance.tenantId || intent.ownerActorId !== acceptance.ownerActorId ||
    intent.idempotencyKeySha256 !== acceptance.idempotencyKeySha256 || intent.requestSha256 !== acceptance.requestSha256 ||
    intent.request.reviewId !== acceptance.reviewId || intent.request.decision !== acceptance.decision ||
    intent.request.expectedReviewToken !== acceptance.expectedReviewToken ||
    intent.request.expectedPolicySha256 !== acceptance.policySha256 ||
    intent.request.expectedSourceManifestSha256 !== acceptance.sourceManifestSha256) {
    context.addIssue({ code: "custom", message: "Stored promotion intent and acceptance are inconsistent." });
  }
});

export type MemoryPromotionNativeRequest = z.infer<typeof memoryPromotionNativeRequestSchema>;
export type MemoryPromotionNativeAcceptance = z.infer<typeof memoryPromotionNativeAcceptanceSchema>;
export type MemoryPromotionNativeSourceTarget = z.infer<typeof memoryPromotionNativeSourceTargetSchema>;
export type MemoryPromotionNativeStoredDecision = z.infer<typeof memoryPromotionNativeStoredDecisionSchema>;

export class MemoryPromotionNativeError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = "MemoryPromotionNativeError";
  }
}

export function memoryPromotionNativeAcceptanceId(tenantId: string, ownerActorId: string, keySha256: string) {
  tenantSchema.parse(tenantId); ownerSchema.parse(ownerActorId); digestSchema.parse(keySha256);
  return `memory-promotion-acceptance:${createHash("sha256").update(JSON.stringify([
    "memory-promotion-acceptance:1", tenantId, ownerActorId, keySha256,
  ])).digest("hex")}`;
}

export function memoryPromotionNativeRequestDigest(input: {
  tenantId: string; ownerActorId: string; request: MemoryPromotionNativeRequest;
}) {
  tenantSchema.parse(input.tenantId); ownerSchema.parse(input.ownerActorId);
  const request = memoryPromotionNativeRequestSchema.parse(input.request);
  return memoryContentDigest(input.tenantId, JSON.stringify([
    MEMORY_PROMOTION_NATIVE_DECISION_CONTRACT, input.ownerActorId, request.reviewId, request.decision,
    request.expectedReviewToken, request.expectedPolicySha256, request.expectedSourceManifestSha256,
  ]));
}

export function memoryPromotionNativeIntent(input: {
  tenantId: string; ownerActorId: string; reviewId: string; idempotencyKey: string; request: MemoryPromotionNativeRequest;
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(input.idempotencyKey)) {
    throw new MemoryPromotionNativeError("memory_promotion_key_invalid", 400, "A valid Idempotency-Key is required.");
  }
  const request = memoryPromotionNativeRequestSchema.safeParse(input.request);
  if (!request.success || request.data.reviewId !== input.reviewId) {
    throw new MemoryPromotionNativeError("memory_promotion_request_invalid", 400, "The exact reviewed promotion request is required.");
  }
  const keySha256 = createHash("sha256").update(input.idempotencyKey).digest("hex");
  const requestSha256 = memoryPromotionNativeRequestDigest({ ...input, request: request.data });
  return {
    request: request.data, keySha256, requestSha256,
    acceptanceId: memoryPromotionNativeAcceptanceId(input.tenantId, input.ownerActorId, keySha256),
    stored: memoryPromotionNativeStoredIntentSchema.parse({ schemaVersion: 1, tenantId: input.tenantId,
      ownerActorId: input.ownerActorId, idempotencyKeySha256: keySha256, requestSha256, request: request.data }),
  };
}

export function memoryPromotionNativeReviewToken(input: {
  tenantId: string; ownerActorId: string; reviewId: string; canonicalMemoryId: string;
  sourceClaimSha256: string; sourceTargets: MemoryPromotionNativeSourceTarget[];
  allowedDecisions: ("promote" | "dismiss")[];
}) {
  tenantSchema.parse(input.tenantId); ownerSchema.parse(input.ownerActorId);
  memoryPromotionNativeIdSchema.parse(input.reviewId); memoryPromotionNativeIdSchema.parse(input.canonicalMemoryId);
  digestSchema.parse(input.sourceClaimSha256);
  const sourceTargets = memoryPromotionNativeSourceTargetsSchema.parse(input.sourceTargets);
  const allowedDecisions = z.array(memoryPromotionDecisionSchema).min(1).max(2).parse(input.allowedDecisions);
  return memoryContentDigest(input.tenantId, JSON.stringify([
    "memory-promotion-target:1", input.ownerActorId, input.reviewId, "pending", input.canonicalMemoryId,
    input.sourceClaimSha256, MEMORY_PROMOTION_NATIVE_POLICY_SHA256, sourceTargets, allowedDecisions,
  ]));
}

export function memoryPromotionNativeTokensEqual(left: string, right: string) {
  return digestSchema.safeParse(left).success && digestSchema.safeParse(right).success &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
