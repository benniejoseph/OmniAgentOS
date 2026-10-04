import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { publicMemoryServiceRecord } from "@/lib/app-services/memory";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  explicitMemoryEntityProjectionEligible,
  projectExplicitMemoryEntities,
} from "@/lib/entities/extraction";
import { retireEntityMemoryLineage } from "@/lib/entities/store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { indexUserPrivateMemoryGraphRecords } from "@/lib/memory/graph";
import type { MemoryReconciliationReview } from "@/lib/memory/reconciliation";
import {
  MemoryReconciliationNativeError,
  memoryReconciliationNativeRequestSchema,
} from "@/lib/memory/reconciliation-native-contracts";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import {
  getPrivateMemoryReconciliationReview,
  listPrivateMemoryReconciliationReviews,
  resolvePrivateMemoryReconciliationReview,
} from "@/lib/memory/store";
import {
  NATIVE_MEMORY_RECONCILIATION_READ_CONTRACT,
  nativeMemoryReconciliationIdSchema,
  nativeMemoryReconciliationProjectionsSchema,
  nativeMemoryReconciliationQuerySchema,
  nativeMemoryReconciliationReadQuerySchema,
  nativeMemoryReconciliationReviewSchema,
} from "@/lib/mobile/memory-reconciliation-contracts";
import { canPerform } from "@/lib/security/context";
import { deriveExecutionScope } from "@/lib/security/execution-scope";

function access(caller: AppServiceCaller, purposeId: string, auditPurpose: string) {
  const value = requestMemoryAccessFromSecurityContext(caller.context, {
    purposeId,
    auditPurpose,
    correlationId: caller.executionScope?.correlationId || caller.idempotencyKey || crypto.randomUUID(),
  });
  if (!value) {
    throw new MemoryReconciliationNativeError("memory_reconciliation_authority_invalid", 403,
      "Current authenticated private Memory authority is required.");
  }
  return {
    tenantId: caller.context.tenantId,
    ownerActorId: value.actorBinding.canonicalActorId,
    accessScope: value.databaseAccessScope,
    executionScope: value.executionScope,
  };
}

function scope(authority: ReturnType<typeof access>) {
  return {
    tenantId: authority.tenantId,
    ownerActorId: authority.ownerActorId,
    visibility: "user_private" as const,
  };
}

/** The web and native projections share the same safe Memory record boundary. */
export function publicMemoryReconciliationReview(review: MemoryReconciliationReview) {
  return {
    id: review.id,
    tenantId: review.tenantId,
    kind: review.kind,
    status: review.status,
    ...(review.decision ? { decision: review.decision } : {}),
    detectionReason: review.detectionReason,
    candidate: publicMemoryServiceRecord(review.candidate),
    ...(review.existing ? { existing: publicMemoryServiceRecord(review.existing) } : {}),
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    ...(review.resolvedAt ? { resolvedAt: review.resolvedAt } : {}),
  };
}

function publicNativeReview(caller: AppServiceCaller, current: {
  review: MemoryReconciliationReview;
  reviewToken: string | null;
}) {
  return nativeMemoryReconciliationReviewSchema.parse({
    ...publicMemoryReconciliationReview(current.review),
    reviewToken: canPerform(caller.context.role, "write.memory") ? current.reviewToken : null,
  });
}

export async function listMemoryReconciliationService(
  caller: AppServiceCaller,
  input: z.input<typeof nativeMemoryReconciliationQuerySchema>,
) {
  const value = nativeMemoryReconciliationQuerySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("memory.reconciliation.list"));
  const authority = access(caller, MEMORY_PURPOSE_IDS.read, "api.memory.reconciliation.native.list");
  const current = await listPrivateMemoryReconciliationReviews(authority, {
    status: value.status,
    limit: value.limit,
  });
  const reviews = current.map((item) => publicNativeReview(caller, item));
  return completeAppServiceCall(authorized, {
    contract: NATIVE_MEMORY_RECONCILIATION_READ_CONTRACT,
    scope: scope(authority),
    reviews,
  }, { resourceCount: reviews.length });
}

export async function inspectMemoryReconciliationService(
  caller: AppServiceCaller,
  reviewId: string,
  input: z.input<typeof nativeMemoryReconciliationReadQuerySchema> = {},
) {
  nativeMemoryReconciliationIdSchema.parse(reviewId);
  const query = nativeMemoryReconciliationReadQuerySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("memory.reconciliation.read"));
  const authority = access(caller, MEMORY_PURPOSE_IDS.read, "api.memory.reconciliation.native.read");
  // This is an exact store read. A review outside a bounded list is still
  // recoverable; an inaccessible target never falls back to legacy scope.
  const current = await getPrivateMemoryReconciliationReview(authority, reviewId);
  if (!current) throw new MemoryReconciliationNativeError("memory_reconciliation_not_found", 404,
    "Current private Memory reconciliation review was not found.");
  const acceptance = current.acceptance && (!query.acceptanceKeySha256 ||
    current.acceptance.idempotencyKeySha256 === query.acceptanceKeySha256)
    ? current.acceptance : null;
  return completeAppServiceCall(authorized, {
    contract: NATIVE_MEMORY_RECONCILIATION_READ_CONTRACT,
    scope: scope(authority),
    review: publicNativeReview(caller, current),
    acceptance,
  }, { resourceCount: 1 });
}

export async function resolveMemoryReconciliationService(caller: AppServiceCaller, input: unknown) {
  const request = memoryReconciliationNativeRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("memory.reconciliation.resolve"));
  const authority = access(caller, MEMORY_PURPOSE_IDS.correct, "api.memory.reconciliation.native.resolve");
  if (!caller.idempotencyKey) throw new MemoryReconciliationNativeError("memory_reconciliation_key_invalid", 400,
    "A valid Idempotency-Key is required.");
  const committed = await resolvePrivateMemoryReconciliationReview({
    authority,
    reviewId: request.reviewId,
    idempotencyKey: caller.idempotencyKey,
    request,
  });
  if (!committed) throw new MemoryReconciliationNativeError("memory_reconciliation_not_found", 404,
    "Current private Memory reconciliation review was not found.");

  type Projections = z.infer<typeof nativeMemoryReconciliationProjectionsSchema>;
  const projections: Projections = committed.newlyApplied
    ? { graph: "not_applicable", entities: "not_applicable", retiredLineage: "not_applicable" }
    : { graph: "not_repeated", entities: "not_repeated", retiredLineage: "not_repeated" };
  // Acceptance was atomically committed before these optional projections.
  // A failed projection must not mislabel that durable decision as failed, and
  // an exact read or matching replay never attempts a projection a second time.
  if (committed.newlyApplied) {
    const review = committed.review;
    if (review.candidate.claimStatus === "active") {
      try {
        await indexUserPrivateMemoryGraphRecords([review.candidate], "memory.reconciliation.resolve", {
          tenantId: authority.tenantId,
          accessScope: authority.accessScope,
        });
        projections.graph = "confirmed";
      } catch { projections.graph = "unconfirmed"; }
      if (explicitMemoryEntityProjectionEligible(review.candidate)) {
        try {
          await projectExplicitMemoryEntities({ memory: review.candidate, executionScope: authority.executionScope });
          projections.entities = "confirmed";
        } catch { projections.entities = "unconfirmed"; }
      }
    }
    // Superseded lineage retirement is independent of new entity eligibility:
    // confirming an agent-authored claim must still retire contradicted truth.
    if (review.decision === "confirm_candidate" && review.existing?.claimStatus === "contradicted") {
      try {
        await retireEntityMemoryLineage({
          tenantId: authority.tenantId,
          ownerActorId: authority.ownerActorId,
          memoryIds: [review.existing.id],
          executionScope: deriveExecutionScope(authority.executionScope, { purpose: "memory.reconciliation.resolve.v1" }),
        });
        projections.retiredLineage = "confirmed";
      } catch { projections.retiredLineage = "unconfirmed"; }
    }
  }
  return completeAppServiceCall(authorized, {
    contract: NATIVE_MEMORY_RECONCILIATION_READ_CONTRACT,
    scope: scope(authority),
    review: publicNativeReview(caller, committed),
    acceptance: committed.acceptance,
    replayed: !committed.newlyApplied,
    projections,
  }, { resourceCount: 1 });
}
