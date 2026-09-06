import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseP52EntityResolutionBenchmarkSuite,
  scoreP52EntityResolutionBenchmark,
} from "@/lib/entities/resolution-benchmark";

describe("P5.2 entity-resolution precision gate", () => {
  it("passes the versioned production-like precision and recall suite", async () => {
    const suite = await loadSuite();
    const report = scoreP52EntityResolutionBenchmark(suite);

    expect(report).toMatchObject({
      totalCases: 27,
      passedCases: 27,
      autoLinkPrecisionBasisPoints: 10_000,
      autoLinkRecallBasisPoints: 10_000,
      reviewRecallBasisPoints: 10_000,
      decisionAccuracyBasisPoints: 10_000,
      falseAutoMerges: 0,
      scopeLeaks: 0,
      nondeterministicCases: 0,
      failedCaseIds: [],
      passed: true,
    });
  });

  it("rejects duplicate case identifiers instead of hiding a missing case", async () => {
    const suite = parseP52EntityResolutionBenchmarkSuite(await loadSuite());
    const duplicate = structuredClone(suite);
    duplicate.cases[1].caseId = duplicate.cases[0].caseId;

    expect(() => parseP52EntityResolutionBenchmarkSuite(duplicate)).toThrow(
      "Duplicate benchmark identifier",
    );
  });

  it("rejects a weakened suite that drops an isolation dimension", async () => {
    const suite = parseP52EntityResolutionBenchmarkSuite(await loadSuite());
    const weakened = structuredClone(suite);
    weakened.cases = weakened.cases.filter((testCase) =>
      testCase.dimension !== "actor_isolation"
    );

    expect(() => parseP52EntityResolutionBenchmarkSuite(weakened)).toThrow(
      "Benchmark coverage is missing: actor_isolation",
    );
  });
});

async function loadSuite() {
  return JSON.parse(await readFile(
    path.resolve("evals/p52/entity-resolution.v1.json"),
    "utf8",
  )) as unknown;
}
