import { sourceContractSha256 } from "@/lib/sources/contracts";
import { ADAPTATION_COMPARISON_VERSION, ADAPTATION_SCORER_VERSION, ADAPTATION_COMPARISON_MAX_AGE_MS, adaptationComparisonSuiteSchema, adaptationComparisonSchema, adaptationComparisonPinsSchema, observationSchema, scoreAdaptationOutput, type AdaptationComparison, type AdaptationComparisonPins, type AdaptationComparisonObservation } from "@/lib/agents/adaptation-comparison-schema";
export * from "@/lib/agents/adaptation-comparison-schema";
export function buildAdaptationComparison(input: Pick<AdaptationComparison, "comparisonId" | "adaptationId" | "suite" | "pins" | "completedAt"> & {
  observations: Array<{ caseId: string; baseline: AdaptationComparisonObservation; candidate: AdaptationComparisonObservation }>;
}): AdaptationComparison {
  const suite = adaptationComparisonSuiteSchema.parse(input.suite);
  if (input.observations.length !== suite.cases.length || input.observations.some((row, i) => row.caseId !== suite.cases[i].id)) throw new Error("Comparison cases do not match the pinned suite.");
  const results = input.observations.map((row, i) => ({ ...row,
    baseline: observationSchema.parse(row.baseline), candidate: observationSchema.parse(row.candidate),
    baselinePassed: scoreAdaptationOutput(suite.cases[i], row.baseline),
    candidatePassed: scoreAdaptationOutput(suite.cases[i], row.candidate),
  }));
  const observations = results.flatMap((row) => [row.baseline, row.candidate]);
  const incomplete = observations.some((row) => row.status !== "completed");
  const regressions = results.some((row) => row.baselinePassed && !row.candidatePassed);
  const improvements = results.some((row) => !row.baselinePassed && row.candidatePassed);
  const body = {
    version: ADAPTATION_COMPARISON_VERSION, scorerVersion: ADAPTATION_SCORER_VERSION,
    comparisonId: input.comparisonId, adaptationId: input.adaptationId,
    suite, suiteSha256: sourceContractSha256(suite), pins: adaptationComparisonPinsSchema.parse(input.pins), results,
    verdict: incomplete ? "incomplete" as const : regressions ? "regressed" as const : improvements ? "improved" as const : "no_change" as const,
    baselinePassed: results.filter((row) => row.baselinePassed).length,
    candidatePassed: results.filter((row) => row.candidatePassed).length,
    costUsd: incomplete || observations.some((row) => row.costUsd === null) ? null : observations.reduce((total, row) => total + (row.costUsd || 0), 0),
    completedAt: input.completedAt,
  };
  return adaptationComparisonSchema.parse({ ...body, comparisonSha256: sourceContractSha256(body) });
}
export function parseAdaptationComparison(value: unknown): AdaptationComparison {
  const parsed = adaptationComparisonSchema.parse(value);
  const rebuilt = buildAdaptationComparison({ ...parsed, observations: parsed.results });
  if (rebuilt.comparisonSha256 !== parsed.comparisonSha256 || sourceContractSha256(rebuilt) !== sourceContractSha256(parsed)) throw new Error("Comparison evidence integrity is invalid.");
  return parsed;
}
export function assertAdaptationComparisonActivation(comparison: AdaptationComparison | undefined, pins: Pick<AdaptationComparisonPins, "definitionVersion" | "definitionSha256" | "principalSha256" | "baselineGuidanceSha256" | "candidateEffectSha256" | "runtime">, now = Date.now()) {
  if (!comparison) throw new Error("Run a text comparison before activating this guidance.");
  const result = parseAdaptationComparison(comparison);
  if (result.verdict !== "improved") throw new Error("Activation needs an added passing task with no regressions and all model calls complete.");
  if (now < Date.parse(result.completedAt) || now - Date.parse(result.completedAt) > ADAPTATION_COMPARISON_MAX_AGE_MS) throw new Error("This comparison expired. Run it again before activation.");
  for (const key of Object.keys(pins) as Array<keyof typeof pins>) {
    if (sourceContractSha256(pins[key]) !== sourceContractSha256(result.pins[key])) throw new Error("Agent, model, or active guidance changed. Run the comparison again.");
  }
}
