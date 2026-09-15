import { describe, expect, it } from "vitest";

import {
  parseSemanticMemoryShadowObservationSet,
  scoreSemanticMemoryShadowGate,
  SEMANTIC_MEMORY_SHADOW_DIMENSIONS,
} from "@/lib/evals2/semantic-memory-shadow";

describe("semantic memory shadow activation gate", () => {
  it("passes only a representative, supported, useful, and bounded sample", () => {
    const report = scoreSemanticMemoryShadowGate(passingObservation());

    expect(report).toMatchObject({
      caseCount: 30,
      distinctThreadCount: 6,
      coveredDimensions: [...SEMANTIC_MEMORY_SHADOW_DIMENSIONS].sort(),
      missingDimensions: [],
      quoteValidityBasisPoints: 10_000,
      supportedItemPrecisionBasisPoints: 10_000,
      baselineImportantFactRecallBasisPoints: 5_000,
      semanticImportantFactRecallBasisPoints: 10_000,
      importantFactRecallImprovementBasisPoints: 5_000,
      baselineFirstRelevantRankBasisPoints: 5_000,
      semanticFirstRelevantRankBasisPoints: 10_000,
      firstRelevantRankImprovementBasisPoints: 5_000,
      compressionPassRateBasisPoints: 10_000,
      p95OutputRatioBasisPoints: 3_000,
      p95GenerationLatencyMs: 4_000,
      scopeLeakCount: 0,
      importantEvidenceRegressionCount: 0,
      nondeterministicCaseCount: 0,
      failureCodes: [],
      activationReady: true,
    });
    expect(report.observationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it("fails closed for an undersampled or dimension-incomplete observation", () => {
    const observation = passingObservation();
    observation.cases = observation.cases.slice(0, 5);

    const report = scoreSemanticMemoryShadowGate(observation);

    expect(report.activationReady).toBe(false);
    expect(report.failureCodes).toEqual(expect.arrayContaining([
      "insufficient_cases",
      "insufficient_threads",
      "missing_dimension_coverage",
    ]));
  });

  it("detects weak quality, leakage, regression, latency, and replay drift", () => {
    const observation = passingObservation();
    for (let index = 0; index < 4; index += 1) {
      observation.cases[index] = {
        ...observation.cases[index],
        validQuoteBindingCount: 0,
        supportedSemanticItemCount: 0,
        baselineImportantFactHitCount: 2,
        semanticImportantFactHitCount: 0,
        semanticFirstRelevantRank: null,
        compressionJudgment: "needs_work",
        outputCharacterCount: 900,
        generationLatencyMs: 30_000,
        scopeLeakCount: 1,
        deterministicReplayMatch: false,
      };
    }

    const report = scoreSemanticMemoryShadowGate(observation);

    expect(report.activationReady).toBe(false);
    expect(report.failureCodes).toEqual(expect.arrayContaining([
      "quote_validity_below_threshold",
      "supported_item_precision_below_threshold",
      "compression_quality_below_threshold",
      "output_ratio_above_threshold",
      "generation_latency_above_threshold",
      "scope_leak_detected",
      "important_evidence_regression_detected",
      "nondeterministic_replay_detected",
    ]));
  });

  it("rejects malformed populations, duplicate cases, and active ranking claims", () => {
    const invalidPopulation = passingObservation();
    invalidPopulation.cases[0].validQuoteBindingCount = 3;
    expect(() => parseSemanticMemoryShadowObservationSet(
      invalidPopulation,
    )).toThrow("exceeds its declared population");

    const duplicate = passingObservation();
    duplicate.cases[1].caseId = duplicate.cases[0].caseId;
    expect(() => parseSemanticMemoryShadowObservationSet(duplicate)).toThrow(
      "case identifiers must be unique",
    );

    const active = passingObservation();
    active.rankingEffect = "active" as "none";
    expect(() => parseSemanticMemoryShadowObservationSet(active)).toThrow();
  });
});

function passingObservation() {
  return {
    schemaVersion: 1 as const,
    version: "semantic-memory-shadow-gate:1" as const,
    scorerVersion: "semantic-memory-shadow-scorer:1" as const,
    observedAt: "2026-09-15T12:00:00.000Z",
    dataClassification: "private_content_free_metrics" as const,
    observationMode: "production_shadow_human_reviewed" as const,
    sideEffectPolicy: "none" as const,
    shadowOnly: true as const,
    rankingEffect: "none" as const,
    cases: Array.from({ length: 30 }, (_, index) => ({
      caseId: `shadow-case-${String(index + 1).padStart(2, "0")}`,
      dimension: SEMANTIC_MEMORY_SHADOW_DIMENSIONS[
        index % SEMANTIC_MEMORY_SHADOW_DIMENSIONS.length
      ],
      threadSha256: digest((index % 6) + 1),
      sourceSha256: digest(index + 20),
      enrichmentSha256: digest(index + 80),
      humanReviewed: true as const,
      sourceCharacterCount: 1_000,
      outputCharacterCount: 300,
      generationLatencyMs: 4_000,
      quoteBindingCount: 2,
      validQuoteBindingCount: 2,
      semanticItemCount: 3,
      supportedSemanticItemCount: 3,
      importantFactCount: 2,
      baselineImportantFactHitCount: 1,
      semanticImportantFactHitCount: 2,
      baselineFirstRelevantRank: 2 as number | null,
      semanticFirstRelevantRank: 1 as number | null,
      compressionJudgment: "good" as "good" | "needs_work",
      scopeLeakCount: 0,
      deterministicReplayMatch: true,
    })),
  };
}

function digest(value: number) {
  return value.toString(16).padStart(64, "0");
}
