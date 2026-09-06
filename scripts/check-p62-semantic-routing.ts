import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  evaluateSemanticRoutingBenchmark,
  semanticRoutingSuiteSchema,
  type SemanticRoutingObservation,
} from "../src/lib/evals2/semantic-routing";
import { resolveSemanticIntent } from "../src/lib/orchestration/semantic-intent-resolver";
import { routeAgentRequest } from "../src/lib/orchestration/supervisor";
import { createExecutionScope } from "../src/lib/security/execution-scope";

const tenantId = process.env.P62_BENCHMARK_TENANT_ID?.trim();
const actorId = process.env.P62_BENCHMARK_ACTOR_ID?.trim();
if (!tenantId || !actorId) {
  throw new Error(
    "P62_BENCHMARK_TENANT_ID and P62_BENCHMARK_ACTOR_ID are required.",
  );
}

const fixturePath = resolve(
  process.cwd(),
  "evals/p62/semantic-routing.v1.json",
);
const suite = semanticRoutingSuiteSchema.parse(
  JSON.parse(await readFile(fixturePath, "utf8")),
);

const observations: SemanticRoutingObservation[] = [];
for (const [index, testCase] of suite.cases.entries()) {
  const requestId = `p62-${Date.now()}-${index}`;
  const baseline = routeAgentRequest(testCase.utterance, testCase.mode);
  const resolution = await resolveSemanticIntent({
    tenantId,
    actorId,
    requestId,
    message: testCase.utterance,
    recentConversation: [{ role: "user", content: testCase.utterance }],
    mode: testCase.mode,
    baseline,
    executionScope: createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      correlationId: requestId,
      purpose: "evaluation.p6_2.semantic_routing",
    }),
  });
  observations.push({
    caseId: testCase.id,
    route: resolution.decision.route,
    matchedCapabilityIds: [...resolution.receipt.matchedCapabilityIds],
    source: resolution.receipt.source,
  });
}

const report = evaluateSemanticRoutingBenchmark(suite, observations);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
