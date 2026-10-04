import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { publicMemoryServiceRecord } from "@/lib/app-services/memory";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { explicitMemoryEntityProjectionEligible, projectExplicitMemoryEntities } from "@/lib/entities/extraction";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { indexUserPrivateMemoryGraphRecords } from "@/lib/memory/graph";
import { MemoryPromotionNativeError, memoryPromotionNativeIdSchema, memoryPromotionNativeIntent, memoryPromotionNativeRequestSchema } from "@/lib/memory/promotion-native-contracts";
import {
  getPrivateMemoryPromotionReview, listPrivateMemoryPromotionReviews, resolvePrivateMemoryPromotionReview,
  type PrivateMemoryPromotionRead,
} from "@/lib/memory/promotion-native-store";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import {
  NATIVE_MEMORY_PROMOTION_READ_CONTRACT, nativeMemoryPromotionDecisionResponseForScopeSchema,
  nativeMemoryPromotionListResponseSchema, nativeMemoryPromotionProjectionsSchema, nativeMemoryPromotionQuerySchema,
  nativeMemoryPromotionReadQuerySchema, nativeMemoryPromotionReadResponseForScopeSchema,
  nativeMemoryPromotionReviewSchema, nativeMemoryPromotionSummarySchema,
} from "@/lib/mobile/memory-promotion-contracts";
import { canPerform } from "@/lib/security/context";
import { deriveExecutionScope } from "@/lib/security/execution-scope";
import { idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

function access(caller: AppServiceCaller, operation: "list" | "read" | "decide", reviewId?: string) {
  const execution = caller.executionScope;
  if (operation === "decide" ? !execution || !caller.idempotencyKey ||
    execution.tenantId !== caller.context.tenantId || execution.initiatingActorId !== caller.context.actorId ||
    execution.executingPrincipalType !== "user" || execution.executingPrincipalId !== caller.context.actorId ||
    execution.workspaceId !== null || execution.projectId !== null || execution.missionId !== null ||
    execution.delegationId !== null || execution.contextGrantIds.length > 0 || execution.capabilityGrantIds.length > 0 ||
    execution.purpose !== "api.memory.promotions.decide" || execution.causationId !== reviewId
    : execution !== undefined || caller.idempotencyKey !== undefined) {
    throw new MemoryPromotionNativeError("memory_promotion_authority_invalid", 403, "Current private Memory promotion authority is required.");
  }
  const value = requestMemoryAccessFromSecurityContext(caller.context, {
    purposeId: operation === "decide" ? MEMORY_PURPOSE_IDS.write : MEMORY_PURPOSE_IDS.read,
    auditPurpose: `api.memory.promotions.${operation}`,
    correlationId: execution?.correlationId || crypto.randomUUID(),
  });
  if (!value) throw new MemoryPromotionNativeError("memory_promotion_authority_invalid", 403,
    "An authenticated canonical Memory owner is required.");
  return {
    tenantId: caller.context.tenantId, ownerActorId: value.actorBinding.canonicalActorId,
    accessScope: value.databaseAccessScope,
    executionScope: reviewId ? deriveExecutionScope(value.executionScope, {
      purpose: value.executionScope.purpose, causationId: reviewId,
    }) : value.executionScope,
  };
}
function scope(authority: ReturnType<typeof access>) {
  return { tenantId: authority.tenantId, ownerActorId: authority.ownerActorId, visibility: "user_private" as const };
}
function expectedScope(caller: AppServiceCaller, authority: ReturnType<typeof access>, reviewId: string) {
  return { tenantId: authority.tenantId, ownerActorId: authority.ownerActorId,
    actorId: caller.context.actorId, role: caller.context.role, reviewId };
}
function publicSummary(current: PrivateMemoryPromotionRead, authority: ReturnType<typeof access>) {
  const { review, canonical } = current;
  if (review.ownerActorId !== authority.ownerActorId || review.tenantId !== authority.tenantId ||
    canonical.tenantId !== authority.tenantId || canonical.id !== review.canonicalMemoryId || canonical.scope !== "user" ||
    canonical.claimStatus === "forgotten" || canonical.forgottenAt !== undefined ||
    canonical.accessBinding?.ownerActorId !== authority.ownerActorId || canonical.accessBinding.tenantId !== authority.tenantId ||
    canonical.accessBinding.visibility !== "user_private" || canonical.accessBinding.ownerAgentId !== null ||
    canonical.accessBinding.workspaceId !== null || canonical.accessBinding.projectId !== null || canonical.accessBinding.missionId !== null) {
    throw new Error("Promotion store returned a different private owner boundary.");
  }
  return nativeMemoryPromotionSummarySchema.parse({
    id: review.id, tenantId: review.tenantId, policyVersion: review.policyVersion,
    status: review.status, decision: review.decision ?? null,
    canonicalMemoryId: review.canonicalMemoryId, canonicalTitle: canonical.title,
    sourceMemoryIds: review.sourceMemoryIds, targetTier: review.targetTier,
    promotedMemoryId: review.promotedMemoryId ?? null,
    createdAt: review.createdAt, updatedAt: review.updatedAt, resolvedAt: review.resolvedAt ?? null,
  });
}
function publicReview(caller: AppServiceCaller, current: PrivateMemoryPromotionRead, authority: ReturnType<typeof access>) {
  const canDecide = canPerform(caller.context.role, "write.memory");
  return nativeMemoryPromotionReviewSchema.parse({
    ...publicSummary(current, authority), canonical: publicMemoryServiceRecord(current.canonical),
    sourceTargets: current.sourceTargets, policySha256: current.policySha256, sourceManifestSha256: current.sourceManifestSha256,
    allowedDecisions: canDecide ? current.allowedDecisions : [], reviewToken: canDecide ? current.reviewToken : null,
  });
}
export async function listMemoryPromotionService(caller: AppServiceCaller, input: z.input<typeof nativeMemoryPromotionQuerySchema>) {
  const value = nativeMemoryPromotionQuerySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("memory.promotions.list"));
  const authority = access(caller, "list");
  const rows = await listPrivateMemoryPromotionReviews(authority, value);
  const result = completeAppServiceCall(authorized, {
    contract: NATIVE_MEMORY_PROMOTION_READ_CONTRACT, scope: scope(authority),
    reviews: rows.map((row) => publicSummary(row, authority)),
  }, { resourceCount: rows.length });
  nativeMemoryPromotionListResponseSchema.parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}
export async function inspectMemoryPromotionService(caller: AppServiceCaller, reviewId: string,
  input: z.input<typeof nativeMemoryPromotionReadQuerySchema> = {}) {
  memoryPromotionNativeIdSchema.parse(reviewId);
  const query = nativeMemoryPromotionReadQuerySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("memory.promotions.read"));
  const authority = access(caller, "read", reviewId);
  const current = await getPrivateMemoryPromotionReview(authority, reviewId);
  if (!current) throw new MemoryPromotionNativeError("memory_promotion_not_found", 404, "Current private Memory promotion was not found.");
  const acceptance = current.acceptance && (!query.acceptanceKeySha256 ||
    current.acceptance.idempotencyKeySha256 === query.acceptanceKeySha256) ? current.acceptance : null;
  const result = completeAppServiceCall(authorized, {
    contract: NATIVE_MEMORY_PROMOTION_READ_CONTRACT, scope: scope(authority),
    review: publicReview(caller, current, authority), acceptance,
  }, { resourceCount: 1 });
  nativeMemoryPromotionReadResponseForScopeSchema(expectedScope(caller, authority, reviewId))
    .parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}
export async function decideMemoryPromotionService(caller: AppServiceCaller, input: unknown) {
  const request = memoryPromotionNativeRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("memory.promotions.decide"));
  const authority = access(caller, "decide", request.reviewId);
  const intent = memoryPromotionNativeIntent({ tenantId: authority.tenantId, ownerActorId: authority.ownerActorId,
    reviewId: request.reviewId, idempotencyKey: caller.idempotencyKey!, request });
  const committed = await resolvePrivateMemoryPromotionReview({ authority, reviewId: request.reviewId,
    idempotencyKey: caller.idempotencyKey!, request });
  if (!committed) throw new MemoryPromotionNativeError("memory_promotion_not_found", 404, "Current private Memory promotion was not found.");
  const review = publicReview(caller, committed, authority);
  const expected = {
    ...expectedScope(caller, authority, request.reviewId), executionScope: caller.executionScope,
    serviceKeySha256: idempotencyKeySha256({ tenantId: authority.tenantId, idempotencyKey: caller.idempotencyKey! }),
    rawKeySha256: intent.keySha256, requestSha256: intent.requestSha256, request,
  };
  type Projections = z.infer<typeof nativeMemoryPromotionProjectionsSchema>;
  const projections: Projections = committed.newlyApplied
    ? { graph: request.decision === "promote" ? "unconfirmed" : "not_applicable", entities: "not_applicable" }
    : { graph: "not_repeated", entities: "not_repeated" };
  const finish = () => {
    const result = completeAppServiceCall(authorized, {
      contract: NATIVE_MEMORY_PROMOTION_READ_CONTRACT, scope: scope(authority), review,
      acceptance: committed.acceptance, replayed: !committed.newlyApplied, projections: { ...projections },
    }, { resourceCount: 1 });
    nativeMemoryPromotionDecisionResponseForScopeSchema(expected).parse({ ...result.data, serviceReceipt: result.receipt });
    return result;
  };
  // Validate durable evidence before any optional projection. A malformed
  // post-commit acknowledgement remains uncertain and is recovered by GET.
  finish();
  if (committed.newlyApplied && request.decision === "promote") {
    const memory = committed.promotedMemory;
    if (!memory || memory.id !== committed.acceptance.promotedMemoryId || memory.tenantId !== authority.tenantId ||
      memory.accessBinding?.ownerActorId !== authority.ownerActorId || memory.accessBinding.visibility !== "user_private" ||
      memory.accessBinding.accessScopeSha256 !== committed.canonical.accessBinding?.accessScopeSha256 ||
      memory.scope !== "user" || memory.assertedBy !== committed.canonical.assertedBy ||
      memory.source !== `memory-promotion:${request.reviewId}` || memory.formationReason !== "maintenance_promotion" ||
      memory.tier !== "procedural" || memory.claimStatus !== "active") throw new Error("Committed promotion target is inconsistent.");
    try {
      await indexUserPrivateMemoryGraphRecords([memory], "memory.promotions.decide", {
        tenantId: authority.tenantId, accessScope: authority.accessScope,
      });
      projections.graph = "confirmed";
    } catch { projections.graph = "unconfirmed"; }
    if (explicitMemoryEntityProjectionEligible(memory)) {
      try {
        await projectExplicitMemoryEntities({ memory, executionScope: authority.executionScope });
        projections.entities = "confirmed";
      } catch { projections.entities = "unconfirmed"; }
    }
  }
  return finish();
}
