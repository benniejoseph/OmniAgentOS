import { describe, expect, it } from "vitest";

import {
  buildSemanticShadowReviewPayload,
  type SemanticShadowReviewCandidate,
  type SemanticShadowReviewDraft,
} from "@/components/semantic-shadow-review-queue";

const candidate: SemanticShadowReviewCandidate = {
  id: `semantic_episode_enrichment_${"a".repeat(48)}`,
  reviewSourceSha256: "b".repeat(64),
  startsAt: "2026-09-16T07:00:00.000Z",
  endsAt: "2026-09-16T08:00:00.000Z",
  model: { provider: "openai", model: "memory-model" },
  metrics: {
    sourceCharacterCount: 500,
    outputCharacterCount: 100,
    quoteBindingCount: 2,
    validQuoteBindingCount: 2,
    semanticItemCount: 2,
    generationLatencyMs: 1_200,
    deterministicReplayMatch: true,
  },
  sourceTurns: [],
  deterministicSummary: "Baseline",
  semanticItems: [{
    id: "semantic_summary",
    kind: "summary",
    text: "Semantic summary",
    confidenceBasisPoints: 9_000,
    evidence: [],
  }, {
    id: `semantic_episode_statement_${"c".repeat(48)}`,
    kind: "decision",
    text: "Decision",
    confidenceBasisPoints: 9_000,
    evidence: [],
  }],
  reviewable: true,
};

describe("semantic shadow review form", () => {
  it("builds only a complete explicit human review payload", () => {
    const result = buildSemanticShadowReviewPayload(candidate, draft());

    expect(result).toEqual({
      payload: {
        enrichmentId: candidate.id,
        reviewSourceSha256: candidate.reviewSourceSha256,
        dimension: "decision",
        itemDecisions: [
          { itemId: "semantic_summary", decision: "supported" },
          {
            itemId: `semantic_episode_statement_${"c".repeat(48)}`,
            decision: "unsupported",
          },
        ],
        importantFactCount: 3,
        baselineImportantFactHitCount: 1,
        semanticImportantFactHitCount: 2,
        compressionJudgment: "good",
        scopeLeakCount: 0,
        humanReviewed: true,
      },
    });
  });

  it("refuses silent defaults, partial item judgments, and impossible counts", () => {
    expect(buildSemanticShadowReviewPayload(candidate, {
      ...draft(),
      itemDecisions: { semantic_summary: "supported" },
    }).error).toContain("every semantic item");
    expect(buildSemanticShadowReviewPayload(candidate, {
      ...draft(),
      importantFactCount: "1",
      semanticImportantFactHitCount: "2",
    }).error).toContain("cannot exceed");
    expect(buildSemanticShadowReviewPayload(candidate, {
      ...draft(),
      humanReviewed: false,
    }).error).toContain("Confirm that you compared");
  });
});

function draft(): SemanticShadowReviewDraft {
  return {
    dimension: "decision",
    itemDecisions: {
      semantic_summary: "supported",
      [`semantic_episode_statement_${"c".repeat(48)}`]: "unsupported",
    },
    importantFactCount: "3",
    baselineImportantFactHitCount: "1",
    semanticImportantFactHitCount: "2",
    compressionJudgment: "good",
    scopeLeakCount: "0",
    humanReviewed: true,
  };
}
