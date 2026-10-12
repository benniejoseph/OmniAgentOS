import type { AgentAdaptationV1 } from "@/lib/agents/adaptation-contracts";
import { buildAdaptationComparison } from "@/lib/agents/adaptation-comparison-contracts";
export function withMeasuredComparison(adaptation: AgentAdaptationV1): AgentAdaptationV1 {
  const suite = { cases: [1, 2, 3].map((i) => ({ id: `case-${i}`, task: `Explain example number ${i}.`, assertions: { allOf: ["Next step:"], noneOf: [], minLength: 1, maxLength: 100 } })) };
  return { ...adaptation, comparison: buildAdaptationComparison({ comparisonId: "11111111-1111-4111-8111-111111111111", adaptationId: adaptation.adaptationId, suite,
    pins: { definitionVersion: adaptation.observedDefinitionVersion, definitionSha256: "a".repeat(64), principalSha256: "b".repeat(64), baselineGuidanceSha256: "c".repeat(64), candidateEffectSha256: adaptation.effect.effectSha256, promptContractVersion: "agent-instructions:1", baselineInstructionsSha256: "d".repeat(64), candidateInstructionsSha256: "e".repeat(64), runtime: { provider: "openai", model: "test-model", tier: "fast", source: "deployment_environment", assignmentId: null, assignmentRevision: null, assignmentConfigurationSha256: null }, clock: adaptation.updatedAt, mode: "orchestrate", environment: "text_only_no_tools_memory_or_retrieval", maxOutputTokens: 1000, maxCalls: 6, timeoutMs: 120000 },
    observations: suite.cases.map((row) => ({ caseId: row.id, baseline: { status: "completed", output: "Old behavior", costUsd: null, failure: null }, candidate: { status: "completed", output: "Next step: proceed.", costUsd: null, failure: null } })), completedAt: adaptation.updatedAt,
  }) };
}
