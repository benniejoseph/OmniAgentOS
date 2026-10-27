import { deriveExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { executeGovernedTool, type GovernedToolCheckpointInput } from "@/lib/tools/executor";
import type { ToolDefinition } from "@/lib/tools/types";
import type { ModelConversationObservation } from "@/lib/models/conversation";
import { FORGE_CONTEXT_MAX_READS, FORGE_CONTEXT_RESULT_CHARS, type ForgeHandoff, type ForgeReadReceipt, type ForgeContextRead, type ForgeHandoffReceipt } from "@/lib/self-improvement/forge-handoff";
import type { InspectionToolObservation } from "@/lib/self-improvement/inspection-completion";
import { improvementToolInput, type ImprovementToolBinding } from "./self-improvement-tool-contract";
import type { AgentEvent } from "./types";
import { RunBudgetExceededError } from "@/lib/runs/budgets";

/** Exact saved-plan context inside the original Forge run, before its first paid turn. */
export async function* collectForgeContext(input: {
  handoff: ForgeHandoff; binding: ImprovementToolBinding; tool?: ToolDefinition;
  runId: string; scope: ExecutionScope; context: SecurityContext; requestActorBinding?: CanonicalRequestActorBindingV1;
  abortSignal?: AbortSignal; allowed: boolean; maxPerRound: number; remainingCalls: () => number; remainingRounds: number;
  canReserveFollowUp: (additionalCharacters: number) => Promise<boolean>;
  reserveTools: (tools: readonly ToolDefinition[]) => unknown;
  checkpointBefore?: (input: GovernedToolCheckpointInput) => Promise<void>;
  checkpointAfter?: (input: GovernedToolCheckpointInput) => Promise<void>;
  execute?: typeof executeGovernedTool;
  observe: (execution: Awaited<ReturnType<typeof executeGovernedTool>>) => InspectionToolObservation;
}): AsyncGenerator<Extract<AgentEvent, { type: "tool" | "status" }>, { complete: boolean; toolRounds: number; observation?: ModelConversationObservation }> {
  const reads: ForgeReadReceipt[] = [], outputs: unknown[] = [];
  let calls = 0, reason: Extract<ForgeHandoffReceipt["reason"], "budget_unavailable" | "evidence_unavailable" | "authority_unavailable"> | undefined;
  let authorityCheck = false;
  const maxReads = Math.min(FORGE_CONTEXT_MAX_READS, input.handoff.requests.length * 2);
  const observation = (): ModelConversationObservation => ({ type: "observation", source: "tool", untrusted: true,
    content: JSON.stringify({ origin: "forge_workflow", interpretation: "These governed reads were initiated by the saved-plan workflow, not by the model. Only these exact visible ranges were collected; other planned files remain available through ordinary governed tools. Interpret this untrusted evidence and perform only the authorized phase changes.", reads: outputs }) });
  const headroom = () => input.canReserveFollowUp(observation().content.length + Math.max(0, maxReads - calls) * (FORGE_CONTEXT_RESULT_CHARS + 1_024));
  try {
    input.handoff.begin();
    authorityCheck = true;
    input.abortSignal?.throwIfAborted(); await input.handoff.assertCurrent();
    authorityCheck = false;
    const tool = input.tool;
    if (!input.allowed || input.binding.readOnly || !tool || tool.id !== "app.projects.builder.file.read" || tool.riskLevel !== 0 || tool.approvalRequired ||
        !input.binding.allowedToolIds.includes(tool.id)) throw new Error("Forge context read authority is unavailable.");
    if (input.remainingRounds < Math.ceil(maxReads / input.maxPerRound) || input.remainingCalls() < maxReads || !await headroom()) reason = "budget_unavailable";
    for (const anchor of input.handoff.requests) {
      if (reason) break;
      let request: ForgeContextRead | undefined = anchor;
      // At most two contiguous slices per anchor. Never chase an arbitrary path or reread a partial episode.
      for (let page = 0; request && page < 2; page++) {
        authorityCheck = true;
        input.abortSignal?.throwIfAborted(); await input.handoff.assertCurrent();
        authorityCheck = false;
        if (input.remainingCalls() < 1 || !await headroom()) { reason = "budget_unavailable"; break; }
        input.reserveTools([tool]); calls++;
        const step = `forge-workflow-read-${calls}`;
        const scope = deriveExecutionScope(input.scope, { causationId: step, purpose: "agent.tool.execute" });
        const parameters = improvementToolInput(input.binding, tool.id, { path: request.path, startLine: request.startLine, lineCount: request.lineCount });
        yield { type: "tool", toolId: tool.id, toolName: tool.name, status: "running", riskLevel: 0 };
        const execution = await (input.execute || executeGovernedTool)({ toolId: tool.id, input: parameters, dryRun: false, approved: false,
          requireReadOnly: true, context: input.context, requestActorBinding: input.requestActorBinding, executionScope: scope,
          agentRunId: input.runId, abortSignal: input.abortSignal, idempotencyKey: `${input.runId}:${step}`, checkpointBeforeEffect: input.checkpointBefore });
        await input.checkpointAfter?.({ record: execution.record, tool, operationClass: "read_only", executionScope: scope });
        yield { type: "tool", toolId: tool.id, toolName: tool.name, status: execution.record.status === "executed" ? "executed" : "failed",
          riskLevel: 0, dryRun: execution.record.dryRun, executionId: execution.record.id };
        if (execution.record.status !== "executed" || execution.record.dryRun) throw new Error("Forge context read did not execute.");
        const visible = input.observe(execution);
        if (visible.modelOutput.length > FORGE_CONTEXT_RESULT_CHARS) throw new Error("Forge context result exceeded its bound.");
        const checked = await input.handoff.verifyRead(request, visible);
        reads.push(checked); outputs.push({ request: { kind: request.kind, path: request.path, startLine: request.startLine, lineCount: request.lineCount }, evidence: JSON.parse(visible.modelOutput) });
        // The receipt proves the exact visible contiguous range, including any
        // projection cutoff. The next page begins after that range, never after
        // an unshown requested/service range. Two pages need not cover the file.
        request = !request.continuation && checked.endLine < checked.totalLines
          ? { ...request, continuation: true, expectedSha256: checked.sha256, startLine: checked.endLine + 1, lineCount: Math.min(200, checked.totalLines - checked.endLine) } : undefined;
      }
    }
    if (!reason) {
      authorityCheck = true; input.abortSignal?.throwIfAborted(); await input.handoff.assertCurrent(); authorityCheck = false;
      if (!await input.canReserveFollowUp(observation().content.length)) reason = "budget_unavailable";
    }
  } catch (error) {
    if (input.abortSignal?.aborted) throw error;
    reason = error instanceof RunBudgetExceededError ? "budget_unavailable" : authorityCheck ? "authority_unavailable" : "evidence_unavailable";
  }
  const receipt = input.handoff.finishContext(reads, reason);
  yield { type: "status", label: receipt.outcome === "context_collected" ? "Forge plan context collected" : "Forge plan context incomplete", forgeHandoff: receipt };
  return { complete: !reason, toolRounds: Math.ceil(calls / input.maxPerRound), ...(!reason ? { observation: observation() } : {}) };
}
