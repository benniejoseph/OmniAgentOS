import { describe, expect, it } from "vitest";
import {
  localLearnedRerankerModel,
  rerankRetrievalCandidates,
} from "@/lib/rag/learned-reranker";
import { evaluateRetrievalRerankerBenchmark } from "@/lib/rag/retrieval-reranker-benchmark";

describe("P4.4 local learned reranker", () => {
  it("publishes a reproducible local model contract", () => {
    expect(localLearnedRerankerModel).toMatchObject({
      version: "asael-local-pairwise-reranker:1",
      algorithm: "pairwise_logistic_regression",
      trainingFixtureVersion: "p4.4-reranker-training:1",
      trainingCaseCount: 10,
      externalDisclosure: false,
    });
    expect(
      Object.values(localLearnedRerankerModel.weights).every(Number.isFinite),
    ).toBe(true);
  });

  it("reranks multilingual candidates without an external disclosure", () => {
    const reranked = rerankRetrievalCandidates("restaurar copia base de datos", [
      {
        value: "fresh-unrelated",
        text: "Latest customer invoice renewal",
        baseScore: 0.7,
        freshnessScore: 0.65,
      },
      {
        value: "relevant",
        text: "Database backup restore procedure",
        baseScore: 0.55,
        freshnessScore: 0.5,
      },
    ]);
    expect(reranked.results[0]?.value).toBe("relevant");
    expect(reranked.receipt).toMatchObject({
      externalDisclosure: false,
      candidateCount: 2,
    });
  });

  it("beats the frozen lexical/heuristic baseline on held-out fixtures", () => {
    const report = evaluateRetrievalRerankerBenchmark();
    expect(report.passed).toBe(true);
    expect(report.learnedTopOneAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(report.topOneAccuracyImprovement).toBeGreaterThanOrEqual(0.3);
  });
});
