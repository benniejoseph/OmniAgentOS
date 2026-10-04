import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import {
  memoryPromotionNativeAcceptanceSchema,
  memoryPromotionNativeIdSchema,
  memoryPromotionNativeRequestSchema,
  memoryPromotionNativeSourceTargetsSchema,
} from "@/lib/memory/promotion-native-contracts";
import { nativeMemoryRecordSchema } from "@/lib/mobile/memory-mutation-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const NATIVE_MEMORY_PROMOTION_READ_CONTRACT = "asael-memory-promotion-read:1" as const;
const id = memoryPromotionNativeIdSchema;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.string().datetime({ offset: true });
const decision = z.enum(["promote", "dismiss"]);
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
export const nativeMemoryPromotionScopeSchema = z.object({
  tenantId: z.string().min(1).max(120),
  ownerActorId: z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  visibility: z.literal("user_private"),
}).strict();
export const nativeMemoryPromotionQuerySchema = z.object({
  status: z.enum(["pending", "resolved", "all"]).default("pending"),
  limit: z.number().int().min(1).max(50).default(25),
}).strict();
export const nativeMemoryPromotionReadQuerySchema = z.object({ acceptanceKeySha256: sha.optional() }).strict();
export const nativeMemoryPromotionDecisionRequestSchema = memoryPromotionNativeRequestSchema;
export const nativeMemoryPromotionSummarySchema = z.object({
  id, tenantId: nativeMemoryPromotionScopeSchema.shape.tenantId, policyVersion: z.literal(1),
  status: z.enum(["pending", "resolved"]), decision: decision.nullable(),
  canonicalMemoryId: id, canonicalTitle: z.string().max(240),
  sourceMemoryIds: z.array(id).min(2).max(50), targetTier: z.literal("procedural"),
  promotedMemoryId: id.nullable(), createdAt: at, updatedAt: at, resolvedAt: at.nullable(),
}).strict().superRefine((value, context) => {
  if (!value.sourceMemoryIds.includes(value.canonicalMemoryId) ||
    value.sourceMemoryIds.some((source, index) => index > 0 && value.sourceMemoryIds[index - 1] >= source) ||
    (value.promotedMemoryId !== null && value.sourceMemoryIds.includes(value.promotedMemoryId)) ||
    (value.status === "pending"
      ? value.decision !== null || value.resolvedAt !== null || value.promotedMemoryId !== null
      : value.decision === null || value.resolvedAt === null || (value.decision === "promote") !== (value.promotedMemoryId !== null))) {
    issue(context, "Promotion review identities and resolution state disagree.");
  }
});
export const nativeMemoryPromotionReviewSchema = nativeMemoryPromotionSummarySchema.safeExtend({
  canonical: nativeMemoryRecordSchema,
  sourceTargets: memoryPromotionNativeSourceTargetsSchema,
  policySha256: sha, sourceManifestSha256: sha,
  allowedDecisions: z.array(decision).max(2), reviewToken: sha.nullable(),
}).superRefine((value, context) => {
  const canonical = value.canonical;
  if (canonical.id !== value.canonicalMemoryId || canonical.title !== value.canonicalTitle ||
    canonical.tenantId !== value.tenantId || canonical.scope !== "user" ||
    canonical.access.visibility !== "user_private" || canonical.access.owner !== "current_user" ||
    canonical.access.agentId != null || canonical.access.workspaceId != null ||
    canonical.access.projectId != null || canonical.access.missionId != null ||
    canonical.claimStatus === "forgotten" || canonical.forgottenAt !== undefined ||
    canonicalJsonSha256(value.sourceMemoryIds) !== canonicalJsonSha256(value.sourceTargets.map((target) => target.memoryId)) ||
    value.sourceTargets.find((target) => target.memoryId === canonical.id)?.claimStatus !== canonical.claimStatus ||
    value.sourceManifestSha256 !== canonicalJsonSha256(value.sourceTargets) ||
    new Set(value.allowedDecisions).size !== value.allowedDecisions.length ||
    (value.reviewToken !== null) !== (value.allowedDecisions.length > 0) ||
    (value.allowedDecisions.includes("promote") && !value.allowedDecisions.includes("dismiss")) ||
    (value.status === "resolved" && (value.reviewToken !== null || value.allowedDecisions.length > 0))) {
    issue(context, "Promotion requires a complete current private source manifest and exact decision token.");
  }
});
const base = { contract: z.literal(NATIVE_MEMORY_PROMOTION_READ_CONTRACT), scope: nativeMemoryPromotionScopeSchema };
function receipt(operation: string, mutation = false) {
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== operation || value.resourceType !== "memory_promotion_review" ||
      value.action !== (mutation ? "write.memory" : "read") ||
      value.accessMode !== (mutation ? "mutation" : "read") ||
      value.eventContract !== (mutation ? "memory.atomic-events.v1" : "read_only:no_domain_mutation") ||
      (value.idempotencyKeySha256 !== null) !== mutation) issue(context, "Receipt does not describe this promotion operation.");
  });
}
function outcome(value: { serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, count: number, context: z.RefinementCtx) {
  const { serviceReceipt, ...body } = value;
  if (serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body) || serviceReceipt.resourceCount !== count) {
    issue(context, "Receipt does not bind the exact returned body and count.");
  }
}
type Review = z.infer<typeof nativeMemoryPromotionReviewSchema>;
type Scope = z.infer<typeof nativeMemoryPromotionScopeSchema>;
type Acceptance = z.infer<typeof memoryPromotionNativeAcceptanceSchema>;
function bindReview(scope: Scope, review: Review, acceptance: Acceptance | null, context: z.RefinementCtx) {
  if (scope.tenantId !== review.tenantId) issue(context, "Promotion belongs to another tenant.");
  if (!acceptance) return;
  if (acceptance.tenantId !== scope.tenantId || acceptance.ownerActorId !== scope.ownerActorId ||
    acceptance.reviewId !== review.id || acceptance.canonicalMemoryId !== review.canonicalMemoryId ||
    review.status !== "resolved" || acceptance.decision !== review.decision ||
    acceptance.promotedMemoryId !== review.promotedMemoryId || acceptance.resolvedAt !== review.resolvedAt ||
    canonicalJsonSha256(acceptance.sourceTargets.map((target) => target.memoryId)) !== canonicalJsonSha256(review.sourceMemoryIds)) {
    issue(context, "Acceptance does not bind this owner and observed review decision.");
  }
  for (const accepted of acceptance.sourceTargets) {
    const current = review.sourceTargets.find((target) => target.memoryId === accepted.memoryId);
    if (!current || current.targetRevision < accepted.targetRevision || current.lifecycleRevision < accepted.lifecycleRevision ||
      (current.targetRevision === accepted.targetRevision &&
        (current.claimStatus !== accepted.claimStatus || current.sourcePolicySha256 !== accepted.sourcePolicySha256))) {
      issue(context, "Current source state cannot predate or contradict its accepted revision.");
    }
  }
}
export const nativeMemoryPromotionListResponseSchema = z.object({
  ...base, reviews: z.array(nativeMemoryPromotionSummarySchema).max(50), serviceReceipt: receipt("memory.promotions.list"),
}).strict().superRefine((value, context) => {
  outcome(value, value.reviews.length, context);
  if (new Set(value.reviews.map((review) => review.id)).size !== value.reviews.length ||
    value.reviews.some((review) => review.tenantId !== value.scope.tenantId)) issue(context, "Promotion list contains duplicate or foreign reviews.");
});
export const nativeMemoryPromotionReadResponseSchema = z.object({
  ...base, review: nativeMemoryPromotionReviewSchema, acceptance: memoryPromotionNativeAcceptanceSchema.nullable(),
  serviceReceipt: receipt("memory.promotions.read"),
}).strict().superRefine((value, context) => {
  outcome(value, 1, context); bindReview(value.scope, value.review, value.acceptance, context);
});
const projection = z.enum(["confirmed", "unconfirmed", "not_applicable", "not_repeated"]);
export const nativeMemoryPromotionProjectionsSchema = z.object({ graph: projection, entities: projection }).strict();
export const nativeMemoryPromotionDecisionResponseSchema = z.object({
  ...base, review: nativeMemoryPromotionReviewSchema, acceptance: memoryPromotionNativeAcceptanceSchema,
  replayed: z.boolean(), projections: nativeMemoryPromotionProjectionsSchema,
  serviceReceipt: receipt("memory.promotions.decide", true),
}).strict().superRefine((value, context) => {
  outcome(value, 1, context); bindReview(value.scope, value.review, value.acceptance, context);
  if (Object.values(value.projections).some((state) => (state === "not_repeated") !== value.replayed) ||
    (!value.replayed && (value.review.policySha256 !== value.acceptance.policySha256 ||
      value.review.sourceManifestSha256 !== value.acceptance.sourceManifestSha256)) ||
    (!value.replayed && value.acceptance.decision === "dismiss" &&
      Object.values(value.projections).some((state) => state !== "not_applicable")) ||
    (!value.replayed && value.acceptance.decision === "promote" && value.projections.graph === "not_applicable")) {
    issue(context, "Only a new exact decision may attempt its applicable projections.");
  }
});
export type NativeMemoryPromotionReadScope = {
  tenantId: string; ownerActorId: string; actorId: string; role: string; reviewId: string;
};
export type NativeMemoryPromotionMutationScope = NativeMemoryPromotionReadScope & {
  executionScope: unknown; serviceKeySha256: string; rawKeySha256: string; requestSha256: string;
  request: z.infer<typeof memoryPromotionNativeRequestSchema>;
};
function bindAuthority(value: { scope: Scope; serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, expected: NativeMemoryPromotionReadScope,
  executionScope: unknown, context: z.RefinementCtx) {
  if (value.scope.tenantId !== expected.tenantId || value.scope.ownerActorId !== expected.ownerActorId ||
    value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({
      boundaryVersion: APP_SERVICE_BOUNDARY_VERSION, tenantId: expected.tenantId,
      actorId: expected.actorId, role: expected.role, executionScope,
    })) issue(context, "Promotion response belongs to another current caller authority.");
}
export function nativeMemoryPromotionReadResponseForScopeSchema(expected: NativeMemoryPromotionReadScope) {
  return nativeMemoryPromotionReadResponseSchema.superRefine((value, context) => {
    bindAuthority(value, expected, null, context);
    if (value.review.id !== expected.reviewId) issue(context, "Exact read returned another review.");
  });
}
export function nativeMemoryPromotionDecisionResponseForScopeSchema(expected: NativeMemoryPromotionMutationScope) {
  return nativeMemoryPromotionDecisionResponseSchema.superRefine((value, context) => {
    bindAuthority(value, expected, expected.executionScope, context);
    const accepted = value.acceptance, request = expected.request;
    if (value.review.id !== expected.reviewId || accepted.reviewId !== request.reviewId || accepted.decision !== request.decision ||
      accepted.idempotencyKeySha256 !== expected.rawKeySha256 || accepted.requestSha256 !== expected.requestSha256 ||
      value.serviceReceipt.idempotencyKeySha256 !== expected.serviceKeySha256 ||
      accepted.expectedReviewToken !== request.expectedReviewToken || accepted.policySha256 !== request.expectedPolicySha256 ||
      accepted.sourceManifestSha256 !== request.expectedSourceManifestSha256) issue(context, "Acceptance does not prove this exact submitted intent.");
  });
}
export const nativeMemoryPromotionErrorSchema = z.union([
  z.object({ error: z.string().min(1).max(4_000), code: z.string().max(200).optional() }).strict(),
  z.object({ error: z.string().min(1).max(4_000), message: z.string().max(4_000) }).strict(),
]);
export const nativeMemoryPromotionSchemas = Object.freeze({
  NativeMemoryPromotionQuery: nativeMemoryPromotionQuerySchema,
  NativeMemoryPromotionReadQuery: nativeMemoryPromotionReadQuerySchema,
  NativeMemoryPromotionSummary: nativeMemoryPromotionSummarySchema,
  NativeMemoryPromotionReview: nativeMemoryPromotionReviewSchema,
  NativeMemoryPromotionListResponse: nativeMemoryPromotionListResponseSchema,
  NativeMemoryPromotionReadResponse: nativeMemoryPromotionReadResponseSchema,
  NativeMemoryPromotionDecisionRequest: nativeMemoryPromotionDecisionRequestSchema,
  NativeMemoryPromotionDecisionResponse: nativeMemoryPromotionDecisionResponseSchema,
  NativeMemoryPromotionAcceptance: memoryPromotionNativeAcceptanceSchema,
  NativeMemoryPromotionError: nativeMemoryPromotionErrorSchema,
});
