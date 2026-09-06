import { describe, expect, it } from "vitest";
import {
  compareMemoryCanonicalOrder,
  isVerifiedPromotionEpisode,
  memoryClaimFingerprint,
  memoryLifecyclePolicyV1,
  memoryRetrievalPriorityMultiplier,
  verifiedMemoryOccurrenceKey,
} from "@/lib/memory/lifecycle";
import type { MemoryRecord } from "@/lib/memory/types";

const base: MemoryRecord = {
  id: "memory-a",
  tenantId: "tenant-a",
  type: "episode",
  tier: "episodic",
  tierPolicyVersion: 1,
  formationReason: "verified_effect",
  title: "Deploy completed",
  content: "Release 42 passed the smoke gate.",
  tags: ["release", "production"],
  scope: "user",
  source: "effect-receipt:42",
  importance: 0.8,
  confidence: 0.95,
  claimStatus: "active",
  assertedBy: "system",
  evidenceRefs: ["effect:42"],
  useCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("memory lifecycle policy", () => {
  it("matches normalized exact claims without collapsing distinct evidence", () => {
    const repeated = {
      ...base,
      id: "memory-b",
      title: "  DEPLOY completed ",
      content: "Release 42 passed   the smoke gate.",
      tags: ["production", "release"],
      source: "effect-receipt:43",
      evidenceRefs: ["effect:43"],
    };
    expect(memoryClaimFingerprint(repeated)).toBe(memoryClaimFingerprint(base));
    expect(verifiedMemoryOccurrenceKey(repeated)).not.toBe(
      verifiedMemoryOccurrenceKey(base),
    );
  });

  it("decays retrieval priority without changing claim truth", () => {
    const multiplier = memoryRetrievalPriorityMultiplier(
      base,
      "2026-03-02T00:00:00.000Z",
    );
    expect(multiplier).toBeCloseTo(0.35, 5);
    expect(base.claimStatus).toBe("active");
    expect(memoryLifecyclePolicyV1.decay.mutatesHistoricalTruth).toBe(false);
  });

  it("prioritizes pins and excludes archives", () => {
    expect(memoryRetrievalPriorityMultiplier({
      ...base,
      pinnedAt: "2026-02-01T00:00:00.000Z",
    })).toBe(1.35);
    expect(memoryRetrievalPriorityMultiplier({
      ...base,
      archivedAt: "2026-02-01T00:00:00.000Z",
      archiveReason: "manual",
    })).toBe(0);
  });

  it("chooses the canonical duplicate deterministically and protects pins", () => {
    const newer = {
      ...base,
      id: "memory-b",
      confidence: 0.99,
      createdAt: "2026-02-01T00:00:00.000Z",
    };
    expect([base, newer].sort(compareMemoryCanonicalOrder)[0]?.id).toBe(
      "memory-b",
    );
    expect([
      base,
      { ...newer, pinnedAt: "2026-02-02T00:00:00.000Z" },
    ].sort(compareMemoryCanonicalOrder)[0]?.id).toBe("memory-b");
  });

  it("requires verified, evidenced episodes for promotion", () => {
    expect(isVerifiedPromotionEpisode(base)).toBe(true);
    expect(isVerifiedPromotionEpisode({
      ...base,
      formationReason: "assistant_inference_candidate",
    })).toBe(false);
    expect(isVerifiedPromotionEpisode({ ...base, evidenceRefs: [] })).toBe(false);
  });
});
