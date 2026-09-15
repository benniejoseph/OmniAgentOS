import { z } from "zod";

import { sourceContractSha256 } from "@/lib/sources/contracts";

export const SEMANTIC_MEMORY_SHADOW_GATE_VERSION =
  "semantic-memory-shadow-gate:1" as const;
export const SEMANTIC_MEMORY_SHADOW_SCORER_VERSION =
  "semantic-memory-shadow-scorer:1" as const;

export const SEMANTIC_MEMORY_SHADOW_DIMENSIONS = [
  "decision",
  "commitment",
  "preference",
  "procedure",
  "temporal_change",
  "conflict_correction",
  "multi_topic",
  "noisy_dialogue",
  "long_episode",
  "negative_control",
] as const;

export const SEMANTIC_MEMORY_SHADOW_THRESHOLDS = Object.freeze({
  minimumCases: 24,
  minimumDistinctThreads: 6,
  quoteValidityBasisPoints: 10_000,
  supportedItemPrecisionBasisPoints: 9_800,
  semanticImportantFactRecallBasisPoints: 9_500,
  minimumImportantFactRecallImprovementBasisPoints: 1_000,
  minimumFirstRelevantRankImprovementBasisPoints: 500,
  compressionPassRateBasisPoints: 9_000,
  maximumP95OutputRatioBasisPoints: 5_000,
  maximumP95GenerationLatencyMs: 12_000,
  maximumScopeLeaks: 0,
  maximumImportantEvidenceRegressions: 0,
  maximumNondeterministicCases: 0,
});

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const countSchema = z.number().int().nonnegative().max(1_000_000);
const rankSchema = z.number().int().positive().max(100).nullable();
const dimensionSchema = z.enum(SEMANTIC_MEMORY_SHADOW_DIMENSIONS);

const observationCaseSchema = z.object({
  caseId: z.string().regex(/^shadow-case-[a-z0-9][a-z0-9._-]{0,119}$/),
  dimension: dimensionSchema,
  threadSha256: sha256Schema,
  sourceSha256: sha256Schema,
  enrichmentSha256: sha256Schema,
  humanReviewed: z.literal(true),
  sourceCharacterCount: z.number().int().min(100).max(64_000),
  outputCharacterCount: z.number().int().positive().max(32_000),
  generationLatencyMs: z.number().int().nonnegative().max(120_000),
  quoteBindingCount: z.number().int().positive().max(256),
  validQuoteBindingCount: countSchema,
  semanticItemCount: z.number().int().positive().max(25),
  supportedSemanticItemCount: countSchema,
  importantFactCount: z.number().int().positive().max(128),
  baselineImportantFactHitCount: countSchema,
  semanticImportantFactHitCount: countSchema,
  baselineFirstRelevantRank: rankSchema,
  semanticFirstRelevantRank: rankSchema,
  compressionJudgment: z.enum(["good", "needs_work"]),
  scopeLeakCount: countSchema,
  deterministicReplayMatch: z.boolean(),
}).strict().superRefine((value, context) => {
  for (const [field, count, maximum] of [
    ["validQuoteBindingCount", value.validQuoteBindingCount, value.quoteBindingCount],
    ["supportedSemanticItemCount", value.supportedSemanticItemCount, value.semanticItemCount],
    ["baselineImportantFactHitCount", value.baselineImportantFactHitCount, value.importantFactCount],
    ["semanticImportantFactHitCount", value.semanticImportantFactHitCount, value.importantFactCount],
  ] as const) {
    if (count > maximum) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${field} exceeds its declared population.`,
      });
    }
  }
});

const observationSetSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.literal(SEMANTIC_MEMORY_SHADOW_GATE_VERSION),
  scorerVersion: z.literal(SEMANTIC_MEMORY_SHADOW_SCORER_VERSION),
  observedAt: z.string().datetime({ offset: true }),
  dataClassification: z.literal("private_content_free_metrics"),
  observationMode: z.literal("production_shadow_human_reviewed"),
  sideEffectPolicy: z.literal("none"),
  shadowOnly: z.literal(true),
  rankingEffect: z.literal("none"),
  cases: z.array(observationCaseSchema).min(1).max(256),
}).strict().superRefine((value, context) => {
  const caseIds = new Set<string>();
  for (const [index, testCase] of value.cases.entries()) {
    if (caseIds.has(testCase.caseId)) {
      context.addIssue({
        code: "custom",
        path: ["cases", index, "caseId"],
        message: "Semantic memory shadow case identifiers must be unique.",
      });
    }
    caseIds.add(testCase.caseId);
  }
});

export type SemanticMemoryShadowObservationSet = z.infer<
  typeof observationSetSchema
>;

export type SemanticMemoryShadowFailureCode =
  | "insufficient_cases"
  | "insufficient_threads"
  | "missing_dimension_coverage"
  | "quote_validity_below_threshold"
  | "supported_item_precision_below_threshold"
  | "semantic_recall_below_threshold"
  | "recall_improvement_below_threshold"
  | "rank_improvement_below_threshold"
  | "compression_quality_below_threshold"
  | "output_ratio_above_threshold"
  | "generation_latency_above_threshold"
  | "scope_leak_detected"
  | "important_evidence_regression_detected"
  | "nondeterministic_replay_detected";

export type SemanticMemoryShadowGateReport = Readonly<{
  schemaVersion: 1;
  version: typeof SEMANTIC_MEMORY_SHADOW_GATE_VERSION;
  scorerVersion: typeof SEMANTIC_MEMORY_SHADOW_SCORER_VERSION;
  observationSha256: string;
  caseCount: number;
  distinctThreadCount: number;
  coveredDimensions: readonly string[];
  missingDimensions: readonly string[];
  quoteValidityBasisPoints: number;
  supportedItemPrecisionBasisPoints: number;
  baselineImportantFactRecallBasisPoints: number;
  semanticImportantFactRecallBasisPoints: number;
  importantFactRecallImprovementBasisPoints: number;
  baselineFirstRelevantRankBasisPoints: number;
  semanticFirstRelevantRankBasisPoints: number;
  firstRelevantRankImprovementBasisPoints: number;
  compressionPassRateBasisPoints: number;
  p95OutputRatioBasisPoints: number;
  p95GenerationLatencyMs: number;
  scopeLeakCount: number;
  importantEvidenceRegressionCount: number;
  nondeterministicCaseCount: number;
  thresholds: typeof SEMANTIC_MEMORY_SHADOW_THRESHOLDS;
  failureCodes: readonly SemanticMemoryShadowFailureCode[];
  activationReady: boolean;
}>;

export function parseSemanticMemoryShadowObservationSet(
  value: unknown,
): SemanticMemoryShadowObservationSet {
  return observationSetSchema.parse(value);
}

/**
 * Scores already-adjudicated, content-free shadow observations. This function
 * performs no reads, writes, model calls, retrieval, or clock access. A passing
 * report is an activation prerequisite; it never changes runtime policy.
 */
export function scoreSemanticMemoryShadowGate(
  value: unknown,
): SemanticMemoryShadowGateReport {
  const observation = parseSemanticMemoryShadowObservationSet(value);
  const coveredDimensions = [...new Set(observation.cases.map((testCase) =>
    testCase.dimension
  ))].sort();
  const missingDimensions = SEMANTIC_MEMORY_SHADOW_DIMENSIONS.filter(
    (dimension) => !coveredDimensions.includes(dimension),
  );
  const distinctThreadCount = new Set(
    observation.cases.map((testCase) => testCase.threadSha256),
  ).size;

  const quoteBindingCount = sum(observation.cases, "quoteBindingCount");
  const validQuoteBindingCount = sum(
    observation.cases,
    "validQuoteBindingCount",
  );
  const semanticItemCount = sum(observation.cases, "semanticItemCount");
  const supportedSemanticItemCount = sum(
    observation.cases,
    "supportedSemanticItemCount",
  );
  const importantFactCount = sum(observation.cases, "importantFactCount");
  const baselineImportantFactHitCount = sum(
    observation.cases,
    "baselineImportantFactHitCount",
  );
  const semanticImportantFactHitCount = sum(
    observation.cases,
    "semanticImportantFactHitCount",
  );

  const quoteValidityBasisPoints = ratioBasisPoints(
    validQuoteBindingCount,
    quoteBindingCount,
  );
  const supportedItemPrecisionBasisPoints = ratioBasisPoints(
    supportedSemanticItemCount,
    semanticItemCount,
  );
  const baselineImportantFactRecallBasisPoints = ratioBasisPoints(
    baselineImportantFactHitCount,
    importantFactCount,
  );
  const semanticImportantFactRecallBasisPoints = ratioBasisPoints(
    semanticImportantFactHitCount,
    importantFactCount,
  );
  const importantFactRecallImprovementBasisPoints =
    semanticImportantFactRecallBasisPoints -
    baselineImportantFactRecallBasisPoints;
  const baselineFirstRelevantRankBasisPoints = averageBasisPoints(
    observation.cases.map((testCase) => reciprocalRankBasisPoints(
      testCase.baselineFirstRelevantRank,
    )),
  );
  const semanticFirstRelevantRankBasisPoints = averageBasisPoints(
    observation.cases.map((testCase) => reciprocalRankBasisPoints(
      testCase.semanticFirstRelevantRank,
    )),
  );
  const firstRelevantRankImprovementBasisPoints =
    semanticFirstRelevantRankBasisPoints -
    baselineFirstRelevantRankBasisPoints;
  const compressionPassRateBasisPoints = ratioBasisPoints(
    observation.cases.filter((testCase) =>
      testCase.compressionJudgment === "good"
    ).length,
    observation.cases.length,
  );
  const p95OutputRatioBasisPoints = percentile(
    observation.cases.map((testCase) => ratioBasisPoints(
      testCase.outputCharacterCount,
      testCase.sourceCharacterCount,
    )),
    0.95,
  );
  const p95GenerationLatencyMs = percentile(
    observation.cases.map((testCase) => testCase.generationLatencyMs),
    0.95,
  );
  const scopeLeakCount = observation.cases.reduce(
    (total, testCase) => total + testCase.scopeLeakCount,
    0,
  );
  const importantEvidenceRegressionCount = observation.cases.filter(
    (testCase) =>
      testCase.semanticImportantFactHitCount <
      testCase.baselineImportantFactHitCount,
  ).length;
  const nondeterministicCaseCount = observation.cases.filter(
    (testCase) => !testCase.deterministicReplayMatch,
  ).length;
  const thresholds = SEMANTIC_MEMORY_SHADOW_THRESHOLDS;
  const failureCodes: SemanticMemoryShadowFailureCode[] = [];

  if (observation.cases.length < thresholds.minimumCases) {
    failureCodes.push("insufficient_cases");
  }
  if (distinctThreadCount < thresholds.minimumDistinctThreads) {
    failureCodes.push("insufficient_threads");
  }
  if (missingDimensions.length) {
    failureCodes.push("missing_dimension_coverage");
  }
  if (quoteValidityBasisPoints < thresholds.quoteValidityBasisPoints) {
    failureCodes.push("quote_validity_below_threshold");
  }
  if (
    supportedItemPrecisionBasisPoints <
    thresholds.supportedItemPrecisionBasisPoints
  ) {
    failureCodes.push("supported_item_precision_below_threshold");
  }
  if (
    semanticImportantFactRecallBasisPoints <
    thresholds.semanticImportantFactRecallBasisPoints
  ) {
    failureCodes.push("semantic_recall_below_threshold");
  }
  if (
    importantFactRecallImprovementBasisPoints <
    thresholds.minimumImportantFactRecallImprovementBasisPoints
  ) {
    failureCodes.push("recall_improvement_below_threshold");
  }
  if (
    firstRelevantRankImprovementBasisPoints <
    thresholds.minimumFirstRelevantRankImprovementBasisPoints
  ) {
    failureCodes.push("rank_improvement_below_threshold");
  }
  if (
    compressionPassRateBasisPoints < thresholds.compressionPassRateBasisPoints
  ) {
    failureCodes.push("compression_quality_below_threshold");
  }
  if (
    p95OutputRatioBasisPoints > thresholds.maximumP95OutputRatioBasisPoints
  ) {
    failureCodes.push("output_ratio_above_threshold");
  }
  if (
    p95GenerationLatencyMs > thresholds.maximumP95GenerationLatencyMs
  ) {
    failureCodes.push("generation_latency_above_threshold");
  }
  if (scopeLeakCount > thresholds.maximumScopeLeaks) {
    failureCodes.push("scope_leak_detected");
  }
  if (
    importantEvidenceRegressionCount >
    thresholds.maximumImportantEvidenceRegressions
  ) {
    failureCodes.push("important_evidence_regression_detected");
  }
  if (
    nondeterministicCaseCount > thresholds.maximumNondeterministicCases
  ) {
    failureCodes.push("nondeterministic_replay_detected");
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    version: SEMANTIC_MEMORY_SHADOW_GATE_VERSION,
    scorerVersion: SEMANTIC_MEMORY_SHADOW_SCORER_VERSION,
    observationSha256: sourceContractSha256({
      domain: "asael:semantic-memory-shadow-observation:v1",
      observation,
    }),
    caseCount: observation.cases.length,
    distinctThreadCount,
    coveredDimensions: Object.freeze(coveredDimensions),
    missingDimensions: Object.freeze(missingDimensions),
    quoteValidityBasisPoints,
    supportedItemPrecisionBasisPoints,
    baselineImportantFactRecallBasisPoints,
    semanticImportantFactRecallBasisPoints,
    importantFactRecallImprovementBasisPoints,
    baselineFirstRelevantRankBasisPoints,
    semanticFirstRelevantRankBasisPoints,
    firstRelevantRankImprovementBasisPoints,
    compressionPassRateBasisPoints,
    p95OutputRatioBasisPoints,
    p95GenerationLatencyMs,
    scopeLeakCount,
    importantEvidenceRegressionCount,
    nondeterministicCaseCount,
    thresholds,
    failureCodes: Object.freeze(failureCodes),
    activationReady: failureCodes.length === 0,
  });
}

function sum(
  cases: SemanticMemoryShadowObservationSet["cases"],
  field:
    | "quoteBindingCount"
    | "validQuoteBindingCount"
    | "semanticItemCount"
    | "supportedSemanticItemCount"
    | "importantFactCount"
    | "baselineImportantFactHitCount"
    | "semanticImportantFactHitCount",
) {
  return cases.reduce((total, testCase) => total + testCase[field], 0);
}

function ratioBasisPoints(numerator: number, denominator: number) {
  return denominator ? Math.round((numerator / denominator) * 10_000) : 0;
}

function reciprocalRankBasisPoints(rank: number | null) {
  return rank ? Math.round(10_000 / rank) : 0;
}

function averageBasisPoints(values: readonly number[]) {
  return values.length
    ? Math.round(values.reduce((total, value) => total + value, 0) / values.length)
    : 0;
}

function percentile(values: readonly number[], quantile: number) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(quantile * ordered.length) - 1];
}
