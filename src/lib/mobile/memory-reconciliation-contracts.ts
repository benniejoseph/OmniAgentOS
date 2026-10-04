import { z } from "zod";
import { appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import {
  memoryReconciliationNativeAcceptanceSchema,
  memoryReconciliationNativeRequestSchema,
} from "@/lib/memory/reconciliation-native-contracts";
import {
  memoryReconciliationDecisionSchema,
  memoryReconciliationDetectionReasonSchema,
  memoryReconciliationKindSchema,
  memoryReconciliationStatusSchema,
} from "@/lib/memory/reconciliation";
import { nativeMemoryRecordSchema } from "@/lib/mobile/memory-mutation-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

// Wire publication only. These schemas confer neither memory ownership nor a
// correction purpose; the request-bound service and store recheck both.
export const NATIVE_MEMORY_RECONCILIATION_READ_CONTRACT = "asael-memory-reconciliation-read:1" as const;
export const nativeMemoryReconciliationIdSchema = z.string().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.string().datetime({ offset: true });
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });

export const nativeMemoryReconciliationScopeSchema = z.object({
  tenantId: z.string().min(1).max(120),
  ownerActorId: z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  visibility: z.literal("user_private"),
}).strict();

export const nativeMemoryReconciliationQuerySchema = z.object({
  contract: z.literal(NATIVE_MEMORY_RECONCILIATION_READ_CONTRACT),
  status: z.enum(["pending", "resolved", "all"]).default("pending"),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
export const nativeMemoryReconciliationReadQuerySchema = z.object({
  acceptanceKeySha256: sha.optional(),
}).strict();
export const nativeMemoryReconciliationDecisionRequestSchema = memoryReconciliationNativeRequestSchema;

export const nativeMemoryReconciliationReviewSchema = z.object({
  id: nativeMemoryReconciliationIdSchema,
  tenantId: nativeMemoryReconciliationScopeSchema.shape.tenantId,
  kind: memoryReconciliationKindSchema,
  status: memoryReconciliationStatusSchema,
  decision: memoryReconciliationDecisionSchema.optional(),
  detectionReason: memoryReconciliationDetectionReasonSchema,
  candidate: nativeMemoryRecordSchema,
  existing: nativeMemoryRecordSchema.optional(),
  createdAt: at,
  updatedAt: at,
  resolvedAt: at.optional(),
  reviewToken: sha.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.kind === "contradiction") !== Boolean(value.existing) ||
    value.candidate.id === value.existing?.id ||
    (value.kind === "confirmation" && value.decision === "keep_both")) {
    issue(context, "Review kind must bind its exact distinct targets and allowed decision.");
  }
  if (value.status === "pending" ? value.decision !== undefined || value.resolvedAt !== undefined :
    value.decision === undefined || value.resolvedAt === undefined || value.reviewToken !== null) {
    issue(context, "Review decision, token and resolution state disagree.");
  }
  for (const memory of [value.candidate, value.existing].filter((item) => item !== undefined)) {
    if (memory.tenantId !== value.tenantId || memory.scope !== "user" ||
      memory.access.visibility !== "user_private" || memory.access.owner !== "current_user" ||
      memory.claimStatus === "forgotten") {
      issue(context, "Reconciliation requires currently readable canonical private targets.");
    }
  }
});

const base = {
  contract: z.literal(NATIVE_MEMORY_RECONCILIATION_READ_CONTRACT),
  scope: nativeMemoryReconciliationScopeSchema,
};
function receipt(operation: string, mutation = false) {
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== operation || value.resourceType !== "memory_reconciliation" ||
      value.action !== (mutation ? "write.memory" : "read") ||
      value.accessMode !== (mutation ? "mutation" : "read") ||
      value.eventContract !== (mutation ? "memory.atomic-events.v1" : "read_only:no_domain_mutation") ||
      (value.idempotencyKeySha256 !== null) !== mutation) {
      issue(context, "Receipt does not describe this exact reconciliation operation.");
    }
  });
}
type PublicReview = z.infer<typeof nativeMemoryReconciliationReviewSchema>;
type Scope = z.infer<typeof nativeMemoryReconciliationScopeSchema>;
type Acceptance = z.infer<typeof memoryReconciliationNativeAcceptanceSchema>;
function scoped(scope: Scope, review: PublicReview, context: z.RefinementCtx) {
  if (scope.tenantId !== review.tenantId) issue(context, "Review belongs to another tenant.");
}
function accepted(scope: Scope, review: PublicReview, acceptance: Acceptance | null, context: z.RefinementCtx) {
  if (!acceptance) return;
  if (acceptance.tenantId !== scope.tenantId || acceptance.ownerActorId !== scope.ownerActorId ||
    acceptance.reviewId !== review.id || acceptance.candidateMemoryId !== review.candidate.id ||
    acceptance.existingMemoryId !== (review.existing?.id ?? null) ||
    review.status !== "resolved" || review.decision !== acceptance.decision ||
    review.resolvedAt !== acceptance.resolvedAt) {
    issue(context, "Native acceptance does not bind the observed review resolution.");
  }
}
function outcome(value: { serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, count: number, context: z.RefinementCtx) {
  const { serviceReceipt, ...body } = value;
  if (serviceReceipt.outcomeSha256 !== canonicalJsonSha256(body) || serviceReceipt.resourceCount !== count) {
    issue(context, "Receipt does not bind the exact returned body and count.");
  }
}
export const nativeMemoryReconciliationListResponseSchema = z.object({
  ...base,
  reviews: z.array(nativeMemoryReconciliationReviewSchema).max(100),
  serviceReceipt: receipt("memory.reconciliation.list"),
}).strict().superRefine((value, context) => {
  outcome(value, value.reviews.length, context);
  if (new Set(value.reviews.map((review) => review.id)).size !== value.reviews.length) issue(context, "Duplicate reviews are invalid.");
  for (const review of value.reviews) scoped(value.scope, review, context);
});
export const nativeMemoryReconciliationReadResponseSchema = z.object({
  ...base,
  review: nativeMemoryReconciliationReviewSchema,
  acceptance: memoryReconciliationNativeAcceptanceSchema.nullable(),
  serviceReceipt: receipt("memory.reconciliation.read"),
}).strict().superRefine((value, context) => {
  outcome(value, 1, context);
  scoped(value.scope, value.review, context);
  accepted(value.scope, value.review, value.acceptance, context);
});
const projectionState = z.enum(["confirmed", "unconfirmed", "not_applicable", "not_repeated"]);
export const nativeMemoryReconciliationProjectionsSchema = z.object({
  graph: projectionState,
  entities: projectionState,
  retiredLineage: projectionState,
}).strict();
export const nativeMemoryReconciliationDecisionResponseSchema = z.object({
  ...base,
  review: nativeMemoryReconciliationReviewSchema,
  acceptance: memoryReconciliationNativeAcceptanceSchema,
  replayed: z.boolean(),
  projections: nativeMemoryReconciliationProjectionsSchema,
  serviceReceipt: receipt("memory.reconciliation.resolve", true),
}).strict().superRefine((value, context) => {
  outcome(value, 1, context);
  scoped(value.scope, value.review, context);
  accepted(value.scope, value.review, value.acceptance, context);
  if (Object.values(value.projections).some((state) => (state === "not_repeated") !== value.replayed)) {
    issue(context, "Only a new decision may attempt downstream projections.");
  }
});
export const nativeMemoryReconciliationErrorSchema = z.union([
  z.object({ error: z.string().min(1).max(4_000), code: z.string().max(200).optional() }).strict(),
  z.object({ error: z.string().min(1).max(4_000), message: z.string().max(4_000) }).strict(),
  z.object({ error: z.string().max(4_000), details: z.object({ formErrors: z.array(z.string()), fieldErrors: z.record(z.string(), z.array(z.string()).optional()) }).strict() }).strict(),
]);
export const nativeMemoryReconciliationSchemas = Object.freeze({
  NativeMemoryReconciliationQuery: nativeMemoryReconciliationQuerySchema,
  NativeMemoryReconciliationReadQuery: nativeMemoryReconciliationReadQuerySchema,
  NativeMemoryReconciliationReview: nativeMemoryReconciliationReviewSchema,
  NativeMemoryReconciliationListResponse: nativeMemoryReconciliationListResponseSchema,
  NativeMemoryReconciliationReadResponse: nativeMemoryReconciliationReadResponseSchema,
  NativeMemoryReconciliationDecisionRequest: nativeMemoryReconciliationDecisionRequestSchema,
  NativeMemoryReconciliationDecisionResponse: nativeMemoryReconciliationDecisionResponseSchema,
  NativeMemoryReconciliationError: nativeMemoryReconciliationErrorSchema,
});
