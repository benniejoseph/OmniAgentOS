import { describe, expect, it } from "vitest";

import {
  countPendingEntityMergeReviews,
  type EntityRegistryPayload,
} from "@/components/entity-registry-dialog";

describe("entity registry review visibility", () => {
  it("counts only unresolved ambiguity between active records", () => {
    const registry = fixture();

    expect(countPendingEntityMergeReviews(registry)).toBe(1);

    registry.mergeReviews.push({
      reviewId: "review-a",
      resolutionId: "resolution-merge",
      sourceEntityId: "entity-a",
      targetEntityId: "entity-b",
      decision: "rejected",
      previousReviewId: null,
      reviewedAt: "2026-09-06T00:01:00.000Z",
    });
    expect(countPendingEntityMergeReviews(registry)).toBe(0);
  });

  it("keeps a single-candidate fuzzy match held", () => {
    const registry = fixture();
    registry.resolutions = [registry.resolutions[1]];

    expect(countPendingEntityMergeReviews(registry)).toBe(0);
  });
});

function fixture(): EntityRegistryPayload {
  return {
    schemaVersion: 1,
    entities: [
      entity("entity-a", "Ada Lovelace"),
      entity("entity-b", "Ada L."),
    ],
    aliases: [],
    resolutions: [
      {
        resolutionId: "resolution-merge",
        entityTypeId: "person",
        decision: "review_required",
        selectedEntityId: null,
        candidateEntityIds: ["entity-a", "entity-b"],
        matchMethod: "ambiguous_exact",
        scoreBasisPoints: 10_000,
        decidedAt: "2026-09-06T00:00:00.000Z",
      },
      {
        resolutionId: "resolution-held",
        entityTypeId: "person",
        decision: "review_required",
        selectedEntityId: null,
        candidateEntityIds: ["entity-a"],
        matchMethod: "fuzzy_candidate",
        scoreBasisPoints: 7_500,
        decidedAt: "2026-09-06T00:00:00.000Z",
      },
    ],
    mergeReviews: [],
  };
}

function entity(entityId: string, canonicalLabel: string) {
  return {
    entityId,
    entityTypeId: "person",
    canonicalLabel,
    state: "active" as const,
    mergedIntoEntityId: null,
    lineageCount: 1,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
  };
}
