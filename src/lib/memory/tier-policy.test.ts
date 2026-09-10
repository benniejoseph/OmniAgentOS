import { describe, expect, it } from "vitest";
import {
  canPromoteMemoryTier,
  defaultMemoryTier,
  inferMemoryFormationReason,
  memoryFormationReasonLabel,
  memoryTierPoliciesV1,
  memoryTierRetentionExpiresAt,
  memoryTierSchema,
  resolveMemoryTier,
} from "@/lib/memory/tier-policy";

describe("memory tier policy v1", () => {
  it("defines every required tier with explicit lifecycle rules", () => {
    expect(Object.keys(memoryTierPoliciesV1)).toEqual(memoryTierSchema.options);
    for (const tier of memoryTierSchema.options) {
      const policy = memoryTierPoliciesV1[tier];
      expect(policy).toMatchObject({
        version: 1,
        tier,
        retention: { expiredRecordsAreRetrievable: false },
        promotion: { automatic: false },
        correction: {
          strategy: "superseding_revision",
          preserveHistory: true,
          confidenceIncreaseRequiresEvidence: true,
        },
        retrieval: {
          requiresActiveClaim: true,
          requiresTemporalValidity: true,
          requiresAuthorizedScope: true,
        },
      });
      expect(policy.retrieval.priorityWeight).toBeGreaterThan(0);
    }
  });

  it("maps legacy memory types without losing their meaning", () => {
    expect(defaultMemoryTier("preference")).toBe("preference");
    expect(defaultMemoryTier("fact")).toBe("semantic");
    expect(defaultMemoryTier("episode")).toBe("episodic");
    expect(defaultMemoryTier("procedure")).toBe("procedural");
    expect(defaultMemoryTier("knowledge")).toBe("semantic");
    expect(defaultMemoryTier("decision")).toBe("decision");
    expect(defaultMemoryTier("task")).toBe("commitment");
    expect(resolveMemoryTier("summary", "knowledge")).toBe("summary");
  });

  it("keeps promotion reviewed and evidence-thresholded", () => {
    expect(canPromoteMemoryTier("episodic", "procedural", 1)).toBe(false);
    expect(canPromoteMemoryTier("episodic", "procedural", 2)).toBe(true);
    expect(canPromoteMemoryTier("preference", "semantic", 10)).toBe(false);
  });

  it("calculates bounded retention while leaving durable tiers open", () => {
    const formedAt = "2026-09-06T00:00:00.000Z";
    expect(memoryTierRetentionExpiresAt("working", formedAt)).toBe(
      "2026-09-13T00:00:00.000Z",
    );
    expect(memoryTierRetentionExpiresAt("episodic", formedAt)).toBe(
      "2026-10-06T00:00:00.000Z",
    );
    expect(memoryTierRetentionExpiresAt("preference", formedAt)).toBeUndefined();
    expect(memoryTierRetentionExpiresAt(
      "commitment",
      formedAt,
      "2026-09-30T12:00:00.000Z",
    )).toBe("2026-09-30T12:00:00.000Z");
  });

  it("gives formation provenance a stable non-sensitive reason", () => {
    expect(inferMemoryFormationReason({ formationOrigin: "user_assertion" }))
      .toBe("explicit_user_request");
    expect(inferMemoryFormationReason({
      source: "portable-restore:archive-digest",
    })).toBe("portable_restore");
    expect(inferMemoryFormationReason({
      source: "correction:user",
      supersedesId: "old-memory",
    })).toBe("correction");
    expect(inferMemoryFormationReason({
      formationOrigin: "reviewed_source_cognition",
    })).toBe("source_cognition");
    expect(memoryFormationReasonLabel("source_cognition"))
      .toMatch(/exact source evidence.*accepted through review/i);
  });
});
