import { buildDeterministicRetrievalQueryPlan } from "@/lib/rag/query-planner";
import type {
  RetrievalQueryDomain,
  RetrievalTemporalMode,
} from "@/lib/rag/types";

export type RetrievalQueryPlanBenchmarkCase = Readonly<{
  id: string;
  query: string;
  expectedDomains: readonly RetrievalQueryDomain[];
  temporalMode?: Exclude<RetrievalTemporalMode, "none">;
}>;

export const RETRIEVAL_QUERY_PLAN_BENCHMARK_VERSION =
  "p4.3-query-plan-benchmark:1" as const;

export const RETRIEVAL_QUERY_PLAN_BENCHMARK_THRESHOLDS = Object.freeze({
  domainPrecision: 0.95,
  domainRecall: 0.95,
  temporalModeAccuracy: 0.95,
  originalQueryAnchorRate: 1,
});

export const retrievalQueryPlanBenchmarkCases: readonly RetrievalQueryPlanBenchmarkCase[] = [
  fixture("semantic-explain", "Explain vector database indexing", ["semantic"]),
  fixture("semantic-paraphrase", "Tell me about cache invalidation", ["semantic"]),
  fixture("semantic-meaning", "What does idempotency mean?", ["semantic"]),
  fixture("semantic-overview", "Give an overview of incident response", ["semantic"]),
  fixture("semantic-describe", "Describe zero trust architecture", ["semantic"]),

  fixture("temporal-since", "What changed since July 2026?", ["temporal"], "after"),
  fixture("temporal-as-of", "Show decisions as of Q2 2025", ["temporal"], "as_of"),
  fixture("temporal-before", "Which commitments existed before launch?", ["temporal"], "before"),
  fixture("temporal-latest", "Latest status of the migration", ["temporal"], "latest"),
  fixture("temporal-between", "Events between January and March 2026", ["temporal", "entity"], "between"),
  fixture("temporal-history", "Timeline of the architecture changes", ["temporal"], "timeline"),

  fixture("entity-person", "Who is Alice Chen?", ["entity"]),
  fixture("entity-project", "Find project Orion", ["entity"]),
  fixture("entity-organization", "Find the organization named Acme Labs", ["entity"]),
  fixture("entity-account", "Which account is Northwind?", ["entity"]),
  fixture("entity-product", "Details for product Mercury", ["entity"]),

  fixture("relationship-reporting", "Who reports to Alice Chen?", ["entity", "relationship"]),
  fixture("relationship-manages", "Who manages Project Orion?", ["entity", "relationship"]),
  fixture("relationship-managed", "Who managed Project Orion?", ["entity", "relationship"]),
  fixture("relationship-dependency", "Which service depends on billing-api?", ["entity", "relationship"]),
  fixture("relationship-owner", "Who is the owner of project Orion?", ["entity", "relationship"]),
  fixture("relationship-member", "Which team is Priya a member of?", ["entity", "relationship"]),
  fixture("relationship-connected", "What is connected to the Atlas account?", ["semantic", "entity", "relationship"]),

  fixture("procedural-walkthrough", "Walk me through rotating database credentials", ["procedural"]),
  fixture("procedural-runbook", "What's the runbook for a failed worker?", ["procedural"]),
  fixture("procedural-process", "What is the process for restoring a backup?", ["semantic", "procedural"]),
  fixture("procedural-how", "How should I configure the queue?", ["procedural"]),
  fixture("procedural-steps", "List the steps to migrate the index", ["procedural"]),

  fixture("mixed-temporal-relationship", "Who owned project Orion before 2025?", ["temporal", "entity", "relationship"], "before"),
  fixture("mixed-procedure-entity", "How do I deploy product Mercury?", ["entity", "procedural"]),
  fixture("mixed-latest-entity", "What is the latest decision for account Northwind?", ["semantic", "temporal", "entity"], "latest"),
  fixture("mixed-as-of-relationship", "Who reported to Alice as of June 2024?", ["temporal", "entity", "relationship"], "as_of"),
] as const;

export function evaluateRetrievalQueryPlanBenchmark(
  cases: readonly RetrievalQueryPlanBenchmarkCase[] =
    retrievalQueryPlanBenchmarkCases,
) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let temporalCorrect = 0;
  let temporalCases = 0;
  let anchorCorrect = 0;

  const results = cases.map((benchmarkCase) => {
    const plan = buildDeterministicRetrievalQueryPlan(benchmarkCase.query);
    const expected = new Set(benchmarkCase.expectedDomains);
    const actual = new Set(plan.domains);
    for (const domain of actual) {
      if (expected.has(domain)) truePositive += 1;
      else falsePositive += 1;
    }
    for (const domain of expected) {
      if (!actual.has(domain)) falseNegative += 1;
    }
    if (benchmarkCase.temporalMode) {
      temporalCases += 1;
      if (plan.temporal.mode === benchmarkCase.temporalMode) temporalCorrect += 1;
    }
    const anchored = plan.queries[0] === benchmarkCase.query;
    if (anchored) anchorCorrect += 1;
    return {
      id: benchmarkCase.id,
      expectedDomains: [...expected],
      actualDomains: [...actual],
      expectedTemporalMode: benchmarkCase.temporalMode,
      actualTemporalMode: plan.temporal.mode,
      anchored,
    };
  });

  const domainPrecision = ratio(truePositive, truePositive + falsePositive);
  const domainRecall = ratio(truePositive, truePositive + falseNegative);
  const temporalModeAccuracy = ratio(temporalCorrect, temporalCases);
  const originalQueryAnchorRate = ratio(anchorCorrect, cases.length);
  return {
    version: RETRIEVAL_QUERY_PLAN_BENCHMARK_VERSION,
    caseCount: cases.length,
    thresholds: RETRIEVAL_QUERY_PLAN_BENCHMARK_THRESHOLDS,
    domainPrecision,
    domainRecall,
    temporalModeAccuracy,
    originalQueryAnchorRate,
    passed:
      domainPrecision >= RETRIEVAL_QUERY_PLAN_BENCHMARK_THRESHOLDS.domainPrecision &&
      domainRecall >= RETRIEVAL_QUERY_PLAN_BENCHMARK_THRESHOLDS.domainRecall &&
      temporalModeAccuracy >= RETRIEVAL_QUERY_PLAN_BENCHMARK_THRESHOLDS.temporalModeAccuracy &&
      originalQueryAnchorRate >= RETRIEVAL_QUERY_PLAN_BENCHMARK_THRESHOLDS.originalQueryAnchorRate,
    results,
  };
}

function fixture(
  id: string,
  query: string,
  expectedDomains: readonly RetrievalQueryDomain[],
  temporalMode?: Exclude<RetrievalTemporalMode, "none">,
): RetrievalQueryPlanBenchmarkCase {
  return { id, query, expectedDomains, temporalMode };
}

function ratio(numerator: number, denominator: number) {
  return denominator ? Math.round((numerator / denominator) * 10_000) / 10_000 : 1;
}
