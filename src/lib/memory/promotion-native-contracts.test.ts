import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { memoryPromotedRecordId } from "@/lib/memory/lifecycle";
import {
  MEMORY_PROMOTION_NATIVE_POLICY_SHA256, memoryPromotionNativeAcceptanceSchema, memoryPromotionNativeIntent,
  memoryPromotionNativeRequestSchema, memoryPromotionNativeReviewToken, memoryPromotionNativeSourceTargetsSchema,
  memoryPromotionNativeStoredDecisionSchema, type MemoryPromotionNativeRequest, type MemoryPromotionNativeSourceTarget,
} from "@/lib/memory/promotion-native-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const tenantId = "promotion-contract", ownerActorId = "actor:11111111-1111-4111-8111-111111111111";
const sourceTargets: MemoryPromotionNativeSourceTarget[] = [
  { memoryId: "source-a", claimStatus: "active", targetRevision: 1, lifecycleRevision: 0, sourcePolicySha256: "1".repeat(64) },
  { memoryId: "source-b", claimStatus: "active", targetRevision: 2, lifecycleRevision: 1, sourcePolicySha256: "1".repeat(64) },
];
const identity = { tenantId, ownerActorId, reviewId: "review-a", canonicalMemoryId: "source-a",
  sourceClaimSha256: "2".repeat(64), sourceTargets, allowedDecisions: ["promote", "dismiss"] as ("promote" | "dismiss")[] };
const request: MemoryPromotionNativeRequest = { contract: "asael-memory-promotion-decision:1", reviewId: identity.reviewId,
  decision: "promote", expectedReviewToken: memoryPromotionNativeReviewToken(identity),
  expectedPolicySha256: MEMORY_PROMOTION_NATIVE_POLICY_SHA256, expectedSourceManifestSha256: canonicalJsonSha256(sourceTargets) };
const input = { tenantId, ownerActorId, reviewId: identity.reviewId, request, idempotencyKey: "stable-promotion-key" };
function accepted() {
  const intent = memoryPromotionNativeIntent(input);
  return { contract: "asael-memory-promotion-acceptance:1", id: intent.acceptanceId, tenantId, ownerActorId,
    reviewId: request.reviewId, canonicalMemoryId: identity.canonicalMemoryId, decision: request.decision,
    idempotencyKeySha256: intent.keySha256, requestSha256: intent.requestSha256,
    expectedReviewToken: request.expectedReviewToken, policySha256: request.expectedPolicySha256,
    sourceManifestSha256: request.expectedSourceManifestSha256, sourceTargets,
    promotedMemoryId: memoryPromotedRecordId(request.reviewId), promotedTargetRevision: 1,
    resolvedAt: "2026-10-05T15:00:00.000Z" };
}

describe("exact native Memory promotion contracts", () => {
  it("pins source identity, semantic and lifecycle revisions, policy, owner, and allowed decisions", () => {
    const token = memoryPromotionNativeReviewToken(identity);
    const changes = [
      { ...identity, ownerActorId: "actor:22222222-2222-4222-8222-222222222222" },
      { ...identity, canonicalMemoryId: "source-b" },
      { ...identity, sourceClaimSha256: "3".repeat(64) },
      { ...identity, allowedDecisions: ["dismiss"] as ("promote" | "dismiss")[] },
      ...["targetRevision", "lifecycleRevision", "sourcePolicySha256"].map((key) => ({ ...identity,
        sourceTargets: [{ ...sourceTargets[0], [key]: key === "sourcePolicySha256" ? "4".repeat(64) : 9 }, sourceTargets[1]] })),
    ];
    expect(changes.every((value) => memoryPromotionNativeReviewToken(value) !== token)).toBe(true);
  });
  it("rejects extra metadata, wrong review, unsorted or incomplete source manifests", () => {
    expect(memoryPromotionNativeRequestSchema.safeParse({ ...request, ownerActorId }).success).toBe(false);
    expect(() => memoryPromotionNativeIntent({ ...input, reviewId: "different-review" })).toThrow("exact reviewed");
    expect(memoryPromotionNativeSourceTargetsSchema.safeParse([...sourceTargets].reverse()).success).toBe(false);
    expect(memoryPromotionNativeSourceTargetsSchema.safeParse([sourceTargets[0], sourceTargets[0]]).success).toBe(false);
    expect(memoryPromotionNativeSourceTargetsSchema.safeParse([sourceTargets[0]]).success).toBe(false);
  });
  it("keeps raw-key identity stable while every request pin changes its intent digest", () => {
    const original = memoryPromotionNativeIntent(input);
    expect(original.keySha256).toBe(createHash("sha256").update(input.idempotencyKey).digest("hex"));
    for (const change of [{ decision: "dismiss" as const }, { expectedReviewToken: "5".repeat(64) },
      { expectedPolicySha256: "6".repeat(64) }, { expectedSourceManifestSha256: "7".repeat(64) }]) {
      const revised = memoryPromotionNativeIntent({ ...input, request: { ...request, ...change } });
      expect(revised.acceptanceId).toBe(original.acceptanceId);
      expect(revised.requestSha256).not.toBe(original.requestSha256);
    }
  });
  it("rejects fabricated target identity, altered manifests, and mismatched stored intent", () => {
    const acceptance = accepted(), intent = memoryPromotionNativeIntent(input);
    expect(memoryPromotionNativeAcceptanceSchema.safeParse(acceptance).success).toBe(true);
    for (const change of [{ promotedMemoryId: "another-memory" }, { promotedTargetRevision: null },
      { sourceManifestSha256: "8".repeat(64) }, { canonicalMemoryId: "not-a-source" }, { decision: "dismiss" }]) {
      expect(memoryPromotionNativeAcceptanceSchema.safeParse({ ...acceptance, ...change }).success).toBe(false);
    }
    expect(memoryPromotionNativeStoredDecisionSchema.safeParse({ intent: intent.stored, acceptance }).success).toBe(true);
    expect(memoryPromotionNativeStoredDecisionSchema.safeParse({ intent: { ...intent.stored,
      request: { ...request, expectedReviewToken: "9".repeat(64) } }, acceptance }).success).toBe(false);
  });
});
