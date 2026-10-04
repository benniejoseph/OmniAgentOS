import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { buildUserPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import { memoryPromotedRecordId, type MemoryPromotionReview } from "@/lib/memory/lifecycle";
import {
  MEMORY_PROMOTION_NATIVE_POLICY_SHA256, memoryPromotionNativeAcceptanceSchema,
  memoryPromotionNativeIntent, type MemoryPromotionNativeSourceTarget,
} from "@/lib/memory/promotion-native-contracts";
import type { MemoryRecord } from "@/lib/memory/types";
import type { SecurityContext } from "@/lib/security/types";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const promotionAt = "2026-10-05T12:00:00.123Z";
export const promotionContext: SecurityContext = {
  tenantId: "tenant-promotion", actorId: "owner@example.test", role: "admin", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", sessionId: "test-promotion", tenantName: "Private" },
};
export const promotionOwnerId = `actor:${promotionContext.auth!.userId}`;
export const promotionKey = "promotion-key-one";
export function promotionFixture(options: { resolved?: boolean; newlyApplied?: boolean; decision?: "promote" | "dismiss" } = {}) {
  const resolved = options.resolved ?? true, newlyApplied = options.newlyApplied ?? true, decision = options.decision ?? "promote";
  const canonical: MemoryRecord = {
    id: "memory-a", tenantId: promotionContext.tenantId, type: "episode", tier: "episodic", tierPolicyVersion: 1,
    formationReason: "canonical_source_observation", title: "Prepare review notes", content: "Prepare notes before each project review.",
    tags: ["reviews"], scope: "user", source: "verified-calendar", importance: 0.6, confidence: 0.9,
    claimStatus: "active", assertedBy: "system", evidenceRefs: ["evidence:one"], createdAt: promotionAt, updatedAt: promotionAt,
    embedding: [0.1, 0.2], accessBinding: buildUserPrivateMemoryAccessBindingV1({
      tenantId: promotionContext.tenantId, ownerActorId: promotionOwnerId, originPurpose: "test-promotion", accessBoundAt: promotionAt,
    }),
  };
  const sourceTargets: MemoryPromotionNativeSourceTarget[] = ["memory-a", "memory-b"].map((memoryId) => ({
    memoryId, claimStatus: "active", targetRevision: 3, lifecycleRevision: 1,
    sourcePolicySha256: canonicalJsonSha256(canonical.accessBinding),
  }));
  const request = { contract: "asael-memory-promotion-decision:1" as const, reviewId: "promotion-one", decision,
    expectedReviewToken: "a".repeat(64), expectedPolicySha256: MEMORY_PROMOTION_NATIVE_POLICY_SHA256,
    expectedSourceManifestSha256: canonicalJsonSha256(sourceTargets) };
  const review: MemoryPromotionReview = {
    id: request.reviewId, tenantId: promotionContext.tenantId, ownerActorId: promotionOwnerId,
    policyVersion: 1, status: resolved ? "resolved" : "pending", canonicalMemoryId: canonical.id,
    sourceMemoryIds: sourceTargets.map((target) => target.memoryId), sourceClaimSha256: "b".repeat(64), targetTier: "procedural",
    createdAt: promotionAt, updatedAt: promotionAt,
    ...(resolved ? { decision, resolvedAt: promotionAt, ...(decision === "promote" ? { promotedMemoryId: memoryPromotedRecordId(request.reviewId) } : {}) } : {}),
  };
  const intent = memoryPromotionNativeIntent({ tenantId: promotionContext.tenantId, ownerActorId: promotionOwnerId,
    reviewId: request.reviewId, idempotencyKey: promotionKey, request });
  const acceptance = memoryPromotionNativeAcceptanceSchema.parse({
    contract: "asael-memory-promotion-acceptance:1", id: intent.acceptanceId,
    tenantId: promotionContext.tenantId, ownerActorId: promotionOwnerId, reviewId: review.id, canonicalMemoryId: canonical.id, decision,
    idempotencyKeySha256: intent.keySha256, requestSha256: intent.requestSha256, expectedReviewToken: request.expectedReviewToken,
    policySha256: request.expectedPolicySha256, sourceManifestSha256: request.expectedSourceManifestSha256,
    sourceTargets, promotedMemoryId: decision === "promote" ? memoryPromotedRecordId(review.id) : null,
    promotedTargetRevision: decision === "promote" ? 1 : null, resolvedAt: promotionAt,
  });
  const promotedMemory: MemoryRecord | null = resolved && newlyApplied && decision === "promote" ? {
    ...canonical, id: acceptance.promotedMemoryId!, type: "procedure", tier: "procedural", formationReason: "maintenance_promotion",
    source: `memory-promotion:${review.id}`, evidenceRefs: review.sourceMemoryIds.map((id) => `memory:${id}`),
    promotedFromTier: "episodic", promotedAt: promotionAt,
  } : null;
  return { request, intent, current: { review, canonical, sourceTargets, policySha256: request.expectedPolicySha256,
    sourceManifestSha256: request.expectedSourceManifestSha256,
    allowedDecisions: resolved ? [] : ["promote", "dismiss"] as ("promote" | "dismiss")[],
    reviewToken: resolved ? null : request.expectedReviewToken, acceptance: resolved ? acceptance : null },
  committed: { review, canonical, sourceTargets, policySha256: request.expectedPolicySha256,
    sourceManifestSha256: request.expectedSourceManifestSha256, allowedDecisions: [] as ("promote" | "dismiss")[],
    reviewToken: null, acceptance, newlyApplied, promotedMemory } };
}
export function promotionReadCaller(context = promotionContext) { return createAppServiceCaller({ context }); }
export function promotionMutationCaller() {
  return createRequestMutationAppServiceCaller(new Request("http://localhost/api/memory/promotions", {
    method: "PATCH", headers: { "Idempotency-Key": promotionKey },
  }), promotionContext, { purpose: "api.memory.promotions.decide", causationId: "promotion-one" });
}
