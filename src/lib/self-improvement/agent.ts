import { randomUUID } from "node:crypto";
import { arsenalAgents } from "@/lib/agents/arsenal";
import { resolveAgentIdentityForExecution } from "@/lib/agents/identity-store";
import { resolveDelegationOwnerAuthority } from "@/lib/delegation/custom-profile";
import { runAgent } from "@/lib/orchestration/agent-runner";
import { getAgentRun } from "@/lib/runs/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { redactSensitive } from "@/lib/security/context";
import { executeGovernedTool } from "@/lib/tools/executor";
import { SELF_IMPROVEMENT_BUILDER_TOOLS, SELF_IMPROVEMENT_READ_TOOLS, withSelfImprovementExecution, type SelfImprovementExecutionAuthority } from "./authority";

export async function improvementExecutionContext(authority: SelfImprovementExecutionAuthority, agentId: "atlas" | "forge" | "sentinel", runId: string) {
  await authority.assertCurrent();
  const owner = await resolveDelegationOwnerAuthority(authority.tenantId, authority.ownerActorId);
  // The live authority checks administrator membership. Delegated execution
  // deliberately retains the narrower operator role.
  if (!owner || owner.role === "viewer") throw new Error("The self-improvement owner no longer has execution authority.");
  const identity = await resolveAgentIdentityForExecution({ tenantId: authority.tenantId, actorId: authority.ownerActorId, agentId });
  return {
    identity, requestActorBinding: owner.binding,
    context: { tenantId: authority.tenantId, actorId: authority.ownerActorId, role: owner.role, source: "service" as const },
    scope: createExecutionScope({ tenantId: authority.tenantId, initiatingActorId: authority.ownerActorId,
      executingPrincipalType: "agent", executingPrincipalId: identity.principal.principalId,
      projectId: authority.projectId, correlationId: runId, purpose: "self_improvement.cycle.v1", causationId: authority.cycleId }),
  };
}

export async function executeImprovementTool(input: {
  authority: SelfImprovementExecutionAuthority; toolId: string; parameters: Record<string, unknown>;
  idempotencyKey: string; abortSignal?: AbortSignal;
}) {
  const bound = await improvementExecutionContext(input.authority, "atlas", input.authority.cycleId);
  return withSelfImprovementExecution(input.authority, async () => {
    const result = await executeGovernedTool({ toolId: input.toolId,
      input: { ...input.parameters, projectId: input.authority.projectId }, dryRun: false,
      context: bound.context, requestActorBinding: bound.requestActorBinding, executionScope: bound.scope,
      idempotencyKey: input.idempotencyKey, abortSignal: input.abortSignal });
    if (result.record.status !== "executed") {
      const savedOutput = result.record.output;
      const savedError = savedOutput && typeof savedOutput === "object" && !Array.isArray(savedOutput)
        ? (savedOutput as Record<string, unknown>).error : undefined;
      const reason = typeof savedError === "string" ? savedError : result.record.reason;
      // Only the durable receipt supplies diagnostics. Redact before shortening
      // so a partial private key or credential cannot escape its full pattern.
      const detail = typeof reason === "string"
        ? String(redactSensitive(reason)).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 400) : "";
      throw new Error(`Improvement operation did not execute: ${input.toolId} (${result.record.status}).${detail ? ` Recorded tool error: ${JSON.stringify(detail)}` : ""}`);
    }
    const output = result.result as Record<string, unknown>;
    return { executionId: result.record.id, data: output && typeof output === "object" && "data" in output ? output.data as Record<string, unknown> : output };
  });
}

export async function runImprovementAgent(input: {
  authority: SelfImprovementExecutionAuthority; agentId: "atlas" | "forge" | "sentinel";
  prompt: string; costCeilingUsd: number; abortSignal: AbortSignal;
  onRunStarted: (runId: string) => Promise<void>;
}) {
  const runId = randomUUID();
  const bound = await improvementExecutionContext(input.authority, input.agentId, runId);
  const agent = arsenalAgents.find((item) => item.id === input.agentId)!;
  await input.onRunStarted(runId);
  return withSelfImprovementExecution(input.authority, async () => {
    await input.authority.assertCurrent();
    let measuredCostUsd = 0, metered = true, modelEvents = 0;
    for await (const event of runAgent({ runId, messages: [{ role: "user", content: input.prompt }],
      executionScope: bound.scope, securityContext: bound.context, requestActorBinding: bound.requestActorBinding,
      agentIdentity: bound.identity, agentId: input.agentId, tenantId: input.authority.tenantId,
      actorId: input.authority.ownerActorId, role: bound.context.role, mode: "execute", liveWebPolicy: "disabled",
      memoryFormation: "withheld", specialistIds: [], maxToolSteps: 16,
      budgetLimits: { modelTurns: 20, tokens: 100_000, costMicrousd: Math.floor(input.costCeilingUsd * 1_000_000),
        wallTimeMs: 210_000, toolCalls: 48, browserActions: 0, agents: 1, fanOut: 0, retries: 1, replans: 0 },
      agentProfile: { name: agent.name, role: agent.role, description: agent.description, instructions: agent.persona.operatingStyle,
        persona: agent.persona, modelPolicy: "auto", autonomy: "execute", approvalPolicy: input.authority.readOnly ? "read_only" : "risk_based",
        memoryScope: "session", toolIds: [...(input.authority.allowedToolIds || (input.authority.readOnly ? SELF_IMPROVEMENT_READ_TOOLS : SELF_IMPROVEMENT_BUILDER_TOOLS))], skills: [] },
    }, input.abortSignal)) {
      if (event.type === "model") {
        modelEvents++;
        if (event.costKnown !== true || !Number.isFinite(event.estimatedCostUsd)) metered = false;
        else measuredCostUsd += event.estimatedCostUsd!;
      }
    }
    const run = await getAgentRun(runId, { tenantId: input.authority.tenantId });
    if (!run || run.status !== "completed") throw new Error(`Self-improvement ${input.agentId} run ${run?.status || "missing"}; inspect its retained receipt.`);
    return { runId, response: run.response || "", measuredCostUsd: metered && modelEvents > 0 ? measuredCostUsd : null };
  });
}
