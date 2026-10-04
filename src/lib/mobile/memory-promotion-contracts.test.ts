import { describe, expect, it } from "vitest";
import { authorizeAppServiceCall, completeAppServiceCall } from "@/lib/app-services/contracts";
import { publicMemoryServiceRecord } from "@/lib/app-services/memory";
import {
  nativeMemoryPromotionDecisionRequestSchema, nativeMemoryPromotionDecisionResponseForScopeSchema,
  nativeMemoryPromotionDecisionResponseSchema, nativeMemoryPromotionQuerySchema,
  nativeMemoryPromotionReadResponseForScopeSchema, nativeMemoryPromotionReadResponseSchema,
} from "@/lib/mobile/memory-promotion-contracts";
import { promotionAt, promotionContext, promotionFixture, promotionKey, promotionMutationCaller, promotionOwnerId, promotionReadCaller } from "@/lib/mobile/memory-promotion.test-fixtures";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

function response(mutation = false) {
  const fixture = promotionFixture(), current = fixture.current, review = current.review;
  const data = {
    contract: "asael-memory-promotion-read:1" as const,
    scope: { tenantId: promotionContext.tenantId, ownerActorId: promotionOwnerId, visibility: "user_private" as const },
    review: {
      id: review.id, tenantId: review.tenantId, policyVersion: review.policyVersion, status: review.status,
      decision: review.decision ?? null, canonicalMemoryId: review.canonicalMemoryId, canonicalTitle: current.canonical.title,
      sourceMemoryIds: [...review.sourceMemoryIds], targetTier: review.targetTier, promotedMemoryId: review.promotedMemoryId ?? null,
      createdAt: review.createdAt, updatedAt: review.updatedAt, resolvedAt: review.resolvedAt ?? null,
      canonical: publicMemoryServiceRecord(current.canonical), sourceTargets: structuredClone(current.sourceTargets),
      policySha256: current.policySha256, sourceManifestSha256: current.sourceManifestSha256,
      allowedDecisions: [] as ("promote" | "dismiss")[], reviewToken: null,
    },
    acceptance: fixture.committed.acceptance,
    ...(mutation ? { replayed: false, projections: { graph: "confirmed", entities: "not_applicable" } } : {}),
  };
  const caller = mutation ? promotionMutationCaller() : promotionReadCaller();
  const result = completeAppServiceCall(authorizeAppServiceCall(caller, {
    operation: mutation ? "memory.promotions.decide" : "memory.promotions.read", action: mutation ? "write.memory" : "read",
    resourceType: "memory_promotion_review", accessMode: mutation ? "mutation" : "read",
    eventContract: mutation ? "memory.atomic-events.v1" : "read_only:no_domain_mutation",
  }), data, { resourceCount: 1, occurredAt: promotionAt });
  return { ...result.data, serviceReceipt: result.receipt };
}
function resign<T extends ReturnType<typeof response>>(value: T): T {
  const { serviceReceipt, ...body } = value;
  const { receiptSha256: _digest, ...receipt } = serviceReceipt; void _digest;
  const updated = { ...receipt, outcomeSha256: canonicalJsonSha256(body) };
  return { ...value, serviceReceipt: { ...updated, receiptSha256: canonicalJsonSha256(updated) } };
}
const scope = { tenantId: promotionContext.tenantId, ownerActorId: promotionOwnerId,
  actorId: promotionContext.actorId, role: promotionContext.role, reviewId: "promotion-one" };
describe("native promotion public contract", () => {
  it("requires exact pin/body fields and bounded list inputs", () => {
    const request = promotionFixture().request;
    expect(nativeMemoryPromotionDecisionRequestSchema.safeParse(request).success).toBe(true);
    for (const changed of [{ ...request, action: "decide_promotion" }, { ...request, expectedPolicySha256: undefined },
      { ...request, expectedSourceManifestSha256: undefined }, { ...request, reviewId: "x".repeat(201) }, { ...request, decision: "run" }]) {
      expect(nativeMemoryPromotionDecisionRequestSchema.safeParse(changed).success).toBe(false);
    }
    expect(nativeMemoryPromotionQuerySchema.parse({})).toEqual({ status: "pending", limit: 25 });
    expect(nativeMemoryPromotionQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
  });
  it("keeps raw acceptance key and tenant-scoped service key separate", () => {
    const value = response(true), fixture = promotionFixture();
    expect(value.acceptance.idempotencyKeySha256).not.toBe(value.serviceReceipt.idempotencyKeySha256);
    expect(nativeMemoryPromotionDecisionResponseForScopeSchema({ ...scope,
      executionScope: promotionMutationCaller().executionScope, rawKeySha256: fixture.intent.keySha256,
      serviceKeySha256: idempotencyKeySha256({ tenantId: scope.tenantId, idempotencyKey: promotionKey }),
      requestSha256: fixture.intent.requestSha256, request: fixture.request,
    }).safeParse(value).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThan(3_000_000);
  });
  it("binds current caller role, exact target and canonical owner", () => {
    const value = response();
    expect(nativeMemoryPromotionReadResponseForScopeSchema(scope).safeParse(value).success).toBe(true);
    for (const override of [{ role: "viewer" }, { actorId: "other@example.test" }, { reviewId: "another-review" },
      { ownerActorId: "actor:22222222-2222-4222-8222-222222222222" }, { tenantId: "other-tenant" }]) {
      expect(nativeMemoryPromotionReadResponseForScopeSchema({ ...scope, ...override }).safeParse(value).success).toBe(false);
    }
  });
  it("allows later source revisions on recovery but rejects rollback and equal-revision policy changes", () => {
    const later = response();
    later.review.sourceTargets[1].targetRevision += 1;
    later.review.sourceTargets[1].sourcePolicySha256 = "d".repeat(64);
    later.review.sourceManifestSha256 = canonicalJsonSha256(later.review.sourceTargets);
    expect(nativeMemoryPromotionReadResponseSchema.safeParse(resign(later)).success).toBe(true);
    const rollback = response(); rollback.review.sourceTargets[1].lifecycleRevision = 0;
    rollback.review.sourceManifestSha256 = canonicalJsonSha256(rollback.review.sourceTargets);
    expect(nativeMemoryPromotionReadResponseSchema.safeParse(resign(rollback)).success).toBe(false);
    const changed = response(); changed.review.sourceTargets[1].sourcePolicySha256 = "e".repeat(64);
    changed.review.sourceManifestSha256 = canonicalJsonSha256(changed.review.sourceTargets);
    expect(nativeMemoryPromotionReadResponseSchema.safeParse(resign(changed)).success).toBe(false);
  });
  it("rejects partial manifests, private binding leakage and invalid projection replay", () => {
    const partial = response(); partial.review.sourceTargets.pop();
    partial.review.sourceManifestSha256 = canonicalJsonSha256(partial.review.sourceTargets);
    expect(nativeMemoryPromotionReadResponseSchema.safeParse(resign(partial)).success).toBe(false);
    const foreign = response(); foreign.review.canonical.access.owner = undefined;
    expect(nativeMemoryPromotionReadResponseSchema.safeParse(resign(foreign)).success).toBe(false);
    const replay = response(true); replay.replayed = true;
    expect(nativeMemoryPromotionDecisionResponseSchema.safeParse(resign(replay)).success).toBe(false);
    const brokenDigest = response(); brokenDigest.serviceReceipt.resourceCount = 0;
    expect(nativeMemoryPromotionReadResponseSchema.safeParse(resign(brokenDigest)).success).toBe(false);
  });
});
