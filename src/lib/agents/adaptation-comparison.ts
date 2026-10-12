import "server-only";

import { buildAgentInstructions, AGENT_PROMPT_CONTRACT_VERSION_ID } from "@/lib/orchestration/prompts";
import { selectAgentModel } from "@/lib/models/deployment-route";
import { generateModelText } from "@/lib/models/gateway";
import type { ModelGenerationResult, ModelTextRequest } from "@/lib/models/types";
import { modelAssignmentScopeForAgent } from "@/lib/orchestration/computer-use-routing";
import { resolveRuntimeModelAssignment, type RuntimeModelResolution } from "@/lib/settings/runtime-models";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import type { ResolvedAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import type { AgentAdaptationV1 } from "@/lib/agents/adaptation-contracts";
import type { ActiveAgentAdaptationGuidance, AgentAdaptationOwner } from "@/lib/agents/adaptation-store";
import {
  adaptationComparisonSuiteSchema, buildAdaptationComparison,
  type AdaptationComparisonSuite, type AdaptationComparisonPins, type AdaptationComparisonObservation,
} from "@/lib/agents/adaptation-comparison-contracts";

export function adaptationBaselineSha256(active: readonly ActiveAgentAdaptationGuidance[]) {
  return sourceContractSha256(active.map((item) => ({ adaptationId: item.adaptationId,
    activationVersion: item.activationVersion, guidance: item.guidance,
    evaluationSha256: item.evaluationSha256,
  })));
}
export async function resolveAdaptationComparisonRuntime(input: {
  owner: AgentAdaptationOwner; identity: ResolvedAgentIdentityV1; suite: AdaptationComparisonSuite;
}) {
  const route = selectAgentModel({ message: input.suite.cases.map((item) => item.task).join("\n"), mode: "orchestrate", modelPolicy: input.identity.definition.modelPolicy });
  const runtime = await resolveRuntimeModelAssignment({
    tenantId: input.owner.tenantId, actorId: input.owner.actorId,
    scope: modelAssignmentScopeForAgent(input.identity.definition.logicalAgentId),
    tier: route.tier, requiredFeature: "text", deploymentFallback: route,
  });
  if (!runtime.configured || !runtime.provider || !runtime.model) throw new Error("The Agent model is unavailable. Configure it before running a comparison.");
  return { runtime, pin: adaptationRuntimePin(runtime, route.tier) };
}
export function adaptationRuntimePin(runtime: RuntimeModelResolution, tier: "fast" | "reasoning"): AdaptationComparisonPins["runtime"] {
  if (!runtime.configured || !runtime.provider || !runtime.model) throw new Error("The comparison model is unavailable.");
  return { provider: runtime.provider, model: runtime.model, tier, source: runtime.source,
    assignmentId: runtime.assignmentId || null, assignmentRevision: runtime.assignmentRevision || null,
    assignmentConfigurationSha256: runtime.assignmentConfigurationSha256 || null,
  };
}
export function compileAdaptationComparison(input: {
  identity: ResolvedAgentIdentityV1; adaptation: AgentAdaptationV1;
  active: readonly ActiveAgentAdaptationGuidance[]; suite: AdaptationComparisonSuite;
  runtimePin: AdaptationComparisonPins["runtime"]; clock: string;
}) {
  const { identity, adaptation } = input;
  const suite = adaptationComparisonSuiteSchema.parse(input.suite);
  if (adaptation.state !== "evaluated" || adaptation.evaluation?.verdict !== "passed" ||
      adaptation.observedDefinitionVersion !== identity.definition.definitionVersion ||
      adaptation.agentId !== identity.definition.logicalAgentId || input.active.length >= 10) {
    throw new Error("Check eligibility on the current release before comparing. At most ten guidance items can be active.");
  }
  const base = {
    mode: "orchestrate" as const, agentId: identity.definition.logicalAgentId,
    runtimeClock: { now: new Date(input.clock), timeZone: "UTC" },
    // This experiment intentionally excludes skills as well as retrieval/tools.
    // It measures the definition's text behavior, not live workflow performance.
    profile: { name: identity.definition.name, role: identity.definition.role,
      description: identity.definition.description, instructions: identity.definition.instructions,
      persona: identity.definition.persona, autonomy: identity.principal.autonomy,
      approvalPolicy: identity.principal.approvalPolicy, memoryScope: identity.principal.memoryScope, skills: [],
    },
  };
  const guidance = input.active.map((item) => `Activation v${item.activationVersion}: ${item.guidance}`);
  const baseline = buildAgentInstructions({ ...base, adaptationGuidance: guidance });
  const candidate = buildAgentInstructions({ ...base, adaptationGuidance: [...guidance, `Candidate: ${adaptation.effect.guidance}`] });
  const pins: AdaptationComparisonPins = {
    definitionVersion: identity.definition.definitionVersion, definitionSha256: identity.definition.definitionSha256,
    principalSha256: identity.principal.principalSha256, baselineGuidanceSha256: adaptationBaselineSha256(input.active),
    candidateEffectSha256: adaptation.effect.effectSha256, promptContractVersion: AGENT_PROMPT_CONTRACT_VERSION_ID,
    baselineInstructionsSha256: sourceContractSha256(baseline), candidateInstructionsSha256: sourceContractSha256(candidate),
    runtime: input.runtimePin, clock: input.clock, mode: "orchestrate", environment: "text_only_no_tools_memory_or_retrieval",
    maxOutputTokens: 1_000, maxCalls: suite.cases.length * 2, timeoutMs: 120_000,
  };
  return { suite, pins, baseline, candidate };
}
export const notRunAdaptationObservation = (): AdaptationComparisonObservation => ({ status: "not_run", output: null, costUsd: null, failure: null });

/** The text gateway cannot execute tools, retrieve context, form memory or dispatch workflows. */
export async function runAdaptationComparison(input: {
  comparisonId: string; owner: AgentAdaptationOwner; adaptationId: string;
  compiled: ReturnType<typeof compileAdaptationComparison>; runtime: RuntimeModelResolution; abortSignal?: AbortSignal;
}, dependencies: { generate: (request: ModelTextRequest) => Promise<ModelGenerationResult>; now: () => string } = { generate: generateModelText, now: () => new Date().toISOString() }) {
  const signal = AbortSignal.any([AbortSignal.timeout(input.compiled.pins.timeoutMs), ...(input.abortSignal ? [input.abortSignal] : [])]);
  const observations = input.compiled.suite.cases.map((item) => ({ caseId: item.id, baseline: notRunAdaptationObservation(), candidate: notRunAdaptationObservation() }));
  let stopped = false;
  for (const [index, task] of input.compiled.suite.cases.entries()) {
    // Alternating first variant reduces systematic order bias without changing inputs.
    const order = index % 2 ? ["candidate", "baseline"] as const : ["baseline", "candidate"] as const;
    for (const variant of order) {
      if (stopped) break;
      let failure: AdaptationComparisonObservation["failure"] = "model_failed";
      try {
        signal.throwIfAborted();
        const generated = await dependencies.generate(input.runtime.bind({
          instructions: input.compiled[variant], input: task.task,
          tier: input.compiled.pins.runtime.tier, preferredProvider: input.compiled.pins.runtime.provider,
          allowedProviders: [input.compiled.pins.runtime.provider], allowCrossProviderFallback: false,
          maxAttempts: 1, maxOutputTokens: input.compiled.pins.maxOutputTokens, abortSignal: signal,
          usageScope: {
            tenantId: input.owner.tenantId, actorId: input.owner.canonicalActorId,
            sourceStreamId: `agent:${input.compiled.pins.definitionSha256}`,
            operation: "text_generation", purpose: "agent.adaptation.text_comparison",
            correlationId: input.comparisonId, causationId: input.adaptationId,
            executionScope: createExecutionScope({ tenantId: input.owner.tenantId,
              initiatingActorId: input.owner.canonicalActorId, executingPrincipalType: "user",
              executingPrincipalId: input.owner.canonicalActorId, correlationId: input.comparisonId,
              contextGrantIds: [], capabilityGrantIds: [], purpose: "agent.adaptation.text_comparison" }),
          },
        }));
        signal.throwIfAborted();
        if (generated.provider !== input.compiled.pins.runtime.provider || generated.model !== input.compiled.pins.runtime.model) {
          failure = "route_changed"; throw new Error("Model route changed.");
        }
        if (!generated.text.trim() || generated.text.length > 8_000) {
          failure = "empty_or_oversized_output"; throw new Error("Invalid model output.");
        }
        observations[index][variant] = { status: "completed", output: generated.text,
          costUsd: generated.costKnown && Number.isFinite(generated.estimatedCostUsd) && generated.estimatedCostUsd! >= 0 ? generated.estimatedCostUsd! : null, failure: null };
      } catch {
        observations[index][variant] = { status: "failed", output: null, costUsd: null, failure: signal.aborted ? "cancelled" : failure };
        stopped = true;
      }
    }
  }
  return buildAdaptationComparison({ comparisonId: input.comparisonId, adaptationId: input.adaptationId,
    suite: input.compiled.suite, pins: input.compiled.pins, observations, completedAt: dependencies.now() });
}
