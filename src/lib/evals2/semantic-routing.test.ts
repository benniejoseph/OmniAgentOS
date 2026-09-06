import { describe, expect, it } from "vitest";
import {
  evaluateSemanticRoutingBenchmark,
  type SemanticRoutingSuite,
} from "@/lib/evals2/semantic-routing";

const suite: SemanticRoutingSuite = {
  schemaVersion: 1,
  suiteId: "test-suite",
  cases: Array.from({ length: 20 }, (_, index) => ({
    id: `case-${index}`,
    utterance: `Request ${index}`,
    mode: "orchestrate" as const,
    expectedRoute: index === 19 ? "clarify" as const : "direct" as const,
    requiredToolIds: index < 10 ? [`tool-${index}`] : [],
  })),
};

describe("semantic routing benchmark", () => {
  it("enforces route, tool-recall, model-coverage, and clarification gates", () => {
    const passing = suite.cases.map((testCase, index) => ({
      caseId: testCase.id,
      route: testCase.expectedRoute,
      matchedCapabilityIds: testCase.requiredToolIds,
      source: index === 19
        ? "deterministic_invariant" as const
        : "model" as const,
    }));
    expect(evaluateSemanticRoutingBenchmark(suite, passing)).toMatchObject({
      routeAccuracy: 1,
      requiredToolRecall: 1,
      modelCoverage: 1,
      unexpectedClarificationCount: 0,
      passed: true,
    });

    const failing = passing.map((observation, index) => index === 0
      ? {
          ...observation,
          route: "clarify" as const,
          matchedCapabilityIds: [],
          source: "deterministic_fallback" as const,
        }
      : observation);
    const report = evaluateSemanticRoutingBenchmark(suite, failing);
    expect(report.passed).toBe(false);
    expect(report.routeAccuracy).toBe(0.95);
    expect(report.requiredToolRecall).toBe(0.9);
    expect(report.unexpectedClarificationCount).toBe(1);
    expect(report.fallbackCases).toContain("case-0");
  });
});
