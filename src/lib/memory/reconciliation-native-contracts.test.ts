import { describe, expect, it } from "vitest";
import {
  memoryReconciliationNativeAcceptanceSchema, memoryReconciliationNativeIntent,
  memoryReconciliationNativeRequestSchema, memoryReconciliationNativeToken,
  type MemoryReconciliationNativeIdentity,
} from "@/lib/memory/reconciliation-native-contracts";
import { explicitMemoryEntityProjectionEligible, extractEntitiesFromExplicitMemory } from "@/lib/entities/extraction";
import { buildUserPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import type { MemoryRecord } from "@/lib/memory/types";

const tenantId = "tenant-review", ownerActorId = "actor:11111111-1111-4111-8111-111111111111";
const identity: MemoryReconciliationNativeIdentity = {
  tenantId, ownerActorId, reviewId: "review-a", kind: "contradiction", status: "pending",
  targets: {
    candidate: { memoryId: "memory-a", claimStatus: "candidate", targetRevision: 1, lifecycleRevision: 0 },
    existing: { memoryId: "memory-b", claimStatus: "active", targetRevision: 4, lifecycleRevision: 2 },
  },
};
const request = {
  contract: "asael-memory-reconciliation-decision:1" as const, reviewId: identity.reviewId,
  decision: "confirm_candidate" as const, expectedReviewToken: memoryReconciliationNativeToken(identity),
};

describe("native reconciliation exact acceptance contract", () => {
  it("binds owner, review, exact targets, claim state, semantic and lifecycle counters", () => {
    const token = memoryReconciliationNativeToken(identity);
    const variants: MemoryReconciliationNativeIdentity[] = [
      { ...identity, ownerActorId: "actor:22222222-2222-4222-8222-222222222222" },
      { ...identity, reviewId: "review-b" },
      { ...identity, targets: { ...identity.targets, candidate: { ...identity.targets.candidate, memoryId: "memory-c" } } },
      { ...identity, targets: { ...identity.targets, candidate: { ...identity.targets.candidate, targetRevision: 2 } } },
      { ...identity, targets: { ...identity.targets, existing: { ...identity.targets.existing!, lifecycleRevision: 3 } } },
      { ...identity, targets: { ...identity.targets, existing: { ...identity.targets.existing!, claimStatus: "contradicted" } } },
    ];
    expect(variants.every((value) => memoryReconciliationNativeToken(value) !== token)).toBe(true);
  });
  it("rejects unreviewed request metadata and a request for another review", () => {
    expect(memoryReconciliationNativeRequestSchema.safeParse({ ...request, ownerActorId }).success).toBe(false);
    expect(() => memoryReconciliationNativeIntent({ tenantId, ownerActorId, reviewId: "review-b", idempotencyKey: "stable-key", request }))
      .toThrow("exact review");
  });
  it("holds the key identity stable and changes the request digest for every decision or token", () => {
    const input = { tenantId, ownerActorId, reviewId: identity.reviewId, idempotencyKey: "stable-key", request };
    const original = memoryReconciliationNativeIntent(input);
    const changed = memoryReconciliationNativeIntent({ ...input, request: { ...request, decision: "keep_existing" } });
    expect(changed.acceptanceId).toBe(original.acceptanceId);
    expect(changed.requestSha256).not.toBe(original.requestSha256);
    expect(() => memoryReconciliationNativeIntent({ ...input, idempotencyKey: "" })).toThrow("Idempotency-Key");
  });
  it("rejects acceptance that relabels a target or omits the accepted revision transition", () => {
    const intent = memoryReconciliationNativeIntent({ tenantId, ownerActorId, reviewId: identity.reviewId, idempotencyKey: "stable-key", request });
    const acceptance = {
      contract: "asael-memory-reconciliation-acceptance:1", id: intent.acceptanceId,
      tenantId, ownerActorId, reviewId: identity.reviewId,
      candidateMemoryId: "memory-a", existingMemoryId: "memory-b", decision: request.decision,
      idempotencyKeySha256: intent.keySha256, requestSha256: intent.requestSha256,
      expectedReviewToken: request.expectedReviewToken, resolvedAt: "2026-10-05T01:00:00.000Z", before: identity.targets,
      after: { candidate: { ...identity.targets.candidate, claimStatus: "active", targetRevision: 2 },
        existing: { ...identity.targets.existing!, claimStatus: "contradicted", targetRevision: 5 } },
    };
    expect(memoryReconciliationNativeAcceptanceSchema.safeParse(acceptance).success).toBe(true);
    expect(memoryReconciliationNativeAcceptanceSchema.safeParse({ ...acceptance, candidateMemoryId: "memory-z" }).success).toBe(false);
    expect(memoryReconciliationNativeAcceptanceSchema.safeParse({ ...acceptance, after: identity.targets }).success).toBe(false);
  });
});

describe("entity projection eligibility preserves authorship", () => {
  const memory: MemoryRecord = {
    id: "memory-explicit", tenantId, type: "fact", title: "Person", content: "person: Ada Lovelace", tags: [],
    scope: "user", source: "manual", importance: 1, assertedBy: "user", claimStatus: "active",
    createdAt: "2026-10-05T01:00:00.000Z", updatedAt: "2026-10-05T01:00:00.000Z",
    accessBinding: buildUserPrivateMemoryAccessBindingV1({ tenantId, ownerActorId, originPurpose: "test.memory.reconciliation" }),
  };
  it("matches the explicit extractor while refusing active non-user candidates", () => {
    expect(explicitMemoryEntityProjectionEligible(memory)).toBe(true);
    expect(extractEntitiesFromExplicitMemory(memory).candidates).toHaveLength(1);
    for (const assertedBy of ["agent", "system", "import"] as const) {
      const acceptedCandidate = { ...memory, assertedBy };
      expect(explicitMemoryEntityProjectionEligible(acceptedCandidate)).toBe(false);
      expect(() => extractEntitiesFromExplicitMemory(acceptedCandidate)).toThrow("user-authored");
      expect(acceptedCandidate.assertedBy).toBe(assertedBy);
    }
    expect(explicitMemoryEntityProjectionEligible({ ...memory, claimStatus: "superseded" })).toBe(false);
  });
});
