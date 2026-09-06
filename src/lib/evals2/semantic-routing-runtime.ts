import {
  evaluateSemanticRoutingBenchmark,
  semanticRoutingSuiteSchema,
  type SemanticRoutingObservation,
} from "@/lib/evals2/semantic-routing";
import { resolveSemanticIntent } from "@/lib/orchestration/semantic-intent-resolver";
import { routeAgentRequest } from "@/lib/orchestration/supervisor";
import { createExecutionScope } from "@/lib/security/execution-scope";

export async function runSemanticRoutingBenchmark(input: {
  suite: unknown;
  tenantId: string;
  actorId: string;
  correlationId: string;
}) {
  const suite = semanticRoutingSuiteSchema.parse(input.suite);
  const observations: SemanticRoutingObservation[] = [];
  for (const [index, testCase] of suite.cases.entries()) {
    const requestId = `${input.correlationId}:${index}`;
    const baseline = routeAgentRequest(testCase.utterance, testCase.mode);
    const executionScope = createExecutionScope({
      tenantId: input.tenantId,
      initiatingActorId: input.actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      correlationId: requestId,
      purpose: "agent.intent.semantic_resolution",
    });
    const resolution = await resolveSemanticIntent({
      tenantId: input.tenantId,
      actorId: input.actorId,
      requestId,
      message: testCase.utterance,
      recentConversation: [{ role: "user", content: testCase.utterance }],
      mode: testCase.mode,
      baseline,
      executionScope,
    });
    observations.push({
      caseId: testCase.id,
      route: resolution.decision.route,
      matchedCapabilityIds: [...resolution.receipt.matchedCapabilityIds],
      source: resolution.receipt.source,
    });
  }
  return {
    report: evaluateSemanticRoutingBenchmark(suite, observations),
    observations,
  };
}
