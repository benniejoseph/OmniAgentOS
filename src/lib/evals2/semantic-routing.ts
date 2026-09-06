import { z } from "zod";

export const SEMANTIC_ROUTING_BENCHMARK_VERSION = 1 as const;
export const SEMANTIC_ROUTING_ROUTE_ACCURACY_TARGET = 0.95;
export const SEMANTIC_ROUTING_TOOL_RECALL_TARGET = 0.98;
export const SEMANTIC_ROUTING_MODEL_COVERAGE_TARGET = 0.95;

const semanticRoutingCaseSchema = z.object({
  id: z.string().trim().min(1).max(160),
  utterance: z.string().trim().min(1).max(8_000),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]),
  expectedRoute: z.enum(["direct", "durable_workflow", "clarify"]),
  requiredToolIds: z.array(z.string().trim().min(1).max(512)).max(12),
}).strict();

export const semanticRoutingSuiteSchema = z.object({
  schemaVersion: z.literal(SEMANTIC_ROUTING_BENCHMARK_VERSION),
  suiteId: z.string().trim().min(1).max(160),
  cases: z.array(semanticRoutingCaseSchema).min(20).max(200),
}).strict();

export const semanticRoutingObservationSchema = z.object({
  caseId: z.string().trim().min(1).max(160),
  route: z.enum(["direct", "durable_workflow", "clarify"]),
  matchedCapabilityIds: z.array(z.string().trim().min(1).max(512)).max(48),
  source: z.enum([
    "model",
    "deterministic_invariant",
    "deterministic_fallback",
  ]),
  intent: z.string().trim().min(1).max(80),
  executionShape: z.string().trim().min(1).max(80),
}).strict();

export type SemanticRoutingSuite = z.infer<typeof semanticRoutingSuiteSchema>;
export type SemanticRoutingObservation = z.infer<
  typeof semanticRoutingObservationSchema
>;

export type SemanticRoutingBenchmarkReport = Readonly<{
  schemaVersion: typeof SEMANTIC_ROUTING_BENCHMARK_VERSION;
  suiteId: string;
  caseCount: number;
  routeAccuracy: number;
  requiredToolRecall: number;
  modelCoverage: number;
  unexpectedClarificationCount: number;
  routeFailures: readonly string[];
  missingToolBindings: readonly string[];
  fallbackCases: readonly string[];
  passed: boolean;
}>;

export function evaluateSemanticRoutingBenchmark(
  suiteValue: unknown,
  observationValues: readonly unknown[],
): SemanticRoutingBenchmarkReport {
  const suite = semanticRoutingSuiteSchema.parse(suiteValue);
  const observations = observationValues.map((observation) =>
    semanticRoutingObservationSchema.parse(observation)
  );
  const byCaseId = new Map(
    observations.map((observation) => [observation.caseId, observation]),
  );
  const routeFailures: string[] = [];
  const missingToolBindings: string[] = [];
  const fallbackCases: string[] = [];
  let routeMatches = 0;
  let expectedToolCount = 0;
  let matchedToolCount = 0;
  let semanticCaseCount = 0;
  let modelCaseCount = 0;
  let unexpectedClarificationCount = 0;

  for (const testCase of suite.cases) {
    const observation = byCaseId.get(testCase.id);
    if (!observation || observation.route !== testCase.expectedRoute) {
      routeFailures.push(testCase.id);
    } else {
      routeMatches += 1;
    }
    if (
      observation?.route === "clarify" &&
      testCase.expectedRoute !== "clarify"
    ) {
      unexpectedClarificationCount += 1;
    }
    for (const toolId of testCase.requiredToolIds) {
      expectedToolCount += 1;
      if (observation?.matchedCapabilityIds.includes(toolId)) {
        matchedToolCount += 1;
      } else {
        missingToolBindings.push(`${testCase.id}:${toolId}`);
      }
    }
    if (testCase.expectedRoute !== "clarify") {
      semanticCaseCount += 1;
      if (observation?.source === "model") {
        modelCaseCount += 1;
      } else {
        fallbackCases.push(testCase.id);
      }
    }
  }

  const routeAccuracy = ratio(routeMatches, suite.cases.length);
  const requiredToolRecall = ratio(matchedToolCount, expectedToolCount);
  const modelCoverage = ratio(modelCaseCount, semanticCaseCount);
  return {
    schemaVersion: SEMANTIC_ROUTING_BENCHMARK_VERSION,
    suiteId: suite.suiteId,
    caseCount: suite.cases.length,
    routeAccuracy,
    requiredToolRecall,
    modelCoverage,
    unexpectedClarificationCount,
    routeFailures,
    missingToolBindings,
    fallbackCases,
    passed:
      routeAccuracy >= SEMANTIC_ROUTING_ROUTE_ACCURACY_TARGET &&
      requiredToolRecall >= SEMANTIC_ROUTING_TOOL_RECALL_TARGET &&
      modelCoverage >= SEMANTIC_ROUTING_MODEL_COVERAGE_TARGET &&
      unexpectedClarificationCount === 0,
  };
}

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : 1;
}
