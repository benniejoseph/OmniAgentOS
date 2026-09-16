import { describe, expect, it } from "vitest";

import {
  runSemanticMemoryShadowRankProbe,
  SemanticMemoryShadowRankProbeUnavailableError,
} from "@/lib/evals2/semantic-memory-shadow-rank-probe";

describe("semantic memory shadow retrieval-rank probe", () => {
  it("measures both representations over one deterministic sealed corpus", () => {
    const candidates = corpus();
    const result = runSemanticMemoryShadowRankProbe({
      query: "Which release date was approved for Apollo?",
      targetEnrichmentId: "episode-z-target",
      targetReviewSourceSha256: "f".repeat(64),
      candidates,
    });
    const replay = runSemanticMemoryShadowRankProbe({
      query: "Which release date was approved for Apollo?",
      targetEnrichmentId: "episode-z-target",
      targetReviewSourceSha256: "f".repeat(64),
      candidates: [...candidates].reverse(),
    });

    expect(result).toMatchObject({
      contract: "semantic-memory-shadow-rank-probe:1",
      enrichmentId: "episode-z-target",
      corpusCount: 24,
      semanticFirstRelevantRank: 1,
      humanConfirmedTarget: true,
      rankingEngine: {
        modelVersion: "asael-local-pairwise-reranker:1",
        candidateCount: 24,
        externalDisclosure: false,
      },
    });
    expect(result.baselineFirstRelevantRank).toBeGreaterThan(1);
    expect(result.rankDelta).toBeGreaterThan(0);
    expect(replay).toEqual(result);
  });

  it("refuses undersized or stale corpora", () => {
    expect(() => runSemanticMemoryShadowRankProbe({
      query: "Apollo release date",
      targetEnrichmentId: "episode-z-target",
      targetReviewSourceSha256: "f".repeat(64),
      candidates: corpus().slice(0, 23),
    })).toThrow(SemanticMemoryShadowRankProbeUnavailableError);
    expect(() => runSemanticMemoryShadowRankProbe({
      query: "Apollo release date",
      targetEnrichmentId: "episode-z-target",
      targetReviewSourceSha256: "0".repeat(64),
      candidates: corpus(),
    })).toThrow("changed");
  });
});

function corpus() {
  return [
    ...Array.from({ length: 23 }, (_, index) => ({
      enrichmentId: `episode-${String(index).padStart(2, "0")}`,
      reviewSourceSha256: index.toString(16).padStart(64, "0"),
      deterministicSummary: "General project archive and routine status notes.",
      semanticText: `Routine status note ${index} without a release decision.`,
    })),
    {
      enrichmentId: "episode-z-target",
      reviewSourceSha256: "f".repeat(64),
      deterministicSummary: "General project archive and routine status notes.",
      semanticText: "The Apollo release date was approved for Friday.",
    },
  ];
}
