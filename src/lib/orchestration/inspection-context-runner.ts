import { deriveExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { executeGovernedTool, type GovernedToolCheckpointInput } from "@/lib/tools/executor";
import type { ToolDefinition } from "@/lib/tools/types";
import type { ModelConversationObservation } from "@/lib/models/conversation";
import type { InspectionCompletionGate, InspectionContextRead, InspectionToolObservation } from "@/lib/self-improvement/inspection-completion";
import { improvementToolInput, type ImprovementToolBinding } from "./self-improvement-tool-contract";
import type { AgentEvent } from "./types";
import { projectBuilderExecutionPayload } from "./builder-result-projection";
import { serializeProjectedToolResult } from "./tool-result-projection";
import { RunBudgetExceededError } from "@/lib/runs/budgets";

/** One transparent workflow episode. No synthetic model call, paid turn or retry. */
export async function* collectInspectionContext(input: {
  gate: InspectionCompletionGate; requests: InspectionContextRead[]; binding: ImprovementToolBinding;
  tool?: ToolDefinition; runId: string; scope: ExecutionScope; context: SecurityContext;
  requestActorBinding?: CanonicalRequestActorBindingV1; abortSignal?: AbortSignal;
  allowed: boolean; remainingCalls: number; remainingRounds: number;
  canReserveFollowUp: () => boolean; timeReserved: () => boolean;
  reserveTools: (tools: readonly ToolDefinition[]) => unknown;
  checkpointBefore?: (input: GovernedToolCheckpointInput) => Promise<void>;
  checkpointAfter?: (input: GovernedToolCheckpointInput) => Promise<void>;
  execute?: typeof executeGovernedTool;
  observe: (execution: Awaited<ReturnType<typeof executeGovernedTool>>) => InspectionToolObservation;
}): AsyncGenerator<Extract<AgentEvent, { type: "tool" | "status" }>, { complete: boolean; observation?: ModelConversationObservation }> {
  const executionIds: string[] = [], outputs: unknown[] = [];
  let refusal: "budget_unavailable" | "evidence_unavailable" | undefined;
  try {
    input.abortSignal?.throwIfAborted();
    await input.binding.assertCurrent();
    const tool = input.tool;
    if (!input.allowed || !input.binding.readOnly || !tool || tool.id !== "app.projects.builder.file.read" || tool.riskLevel !== 0 || tool.approvalRequired ||
        !input.binding.allowedToolIds.includes(tool.id)) throw new Error("Inspection context read authority is unavailable.");
    if (input.remainingRounds < 1 || input.remainingCalls < input.requests.length || input.timeReserved() || !input.canReserveFollowUp()) {
      refusal = "budget_unavailable";
    } else {
      // Admit all planned calls first. A partial episode retains its receipts
      // and is never retried under another identity.
      input.reserveTools(input.requests.map(() => tool));
      for (const [index, request] of input.requests.entries()) {
        input.abortSignal?.throwIfAborted();
        await input.binding.assertCurrent();
        if (input.timeReserved() || !input.canReserveFollowUp()) { refusal = "budget_unavailable"; break; }
        const step = `inspection-workflow-read-${index + 1}`;
        const scope = deriveExecutionScope(input.scope, { causationId: step, purpose: "self_improvement.inspection.read" });
        yield { type: "tool", toolId: tool.id, toolName: tool.name, status: "running", riskLevel: 0 };
        const execution = await (input.execute || executeGovernedTool)({
          toolId: tool.id, input: improvementToolInput(input.binding, tool.id, { path: request.path, startLine: request.startLine, lineCount: request.lineCount }),
          dryRun: false, approved: false, requireReadOnly: true, context: input.context,
          requestActorBinding: input.requestActorBinding, executionScope: scope, agentRunId: input.runId,
          abortSignal: input.abortSignal, idempotencyKey: `${input.runId}:${step}`, checkpointBeforeEffect: input.checkpointBefore,
        });
        await input.checkpointAfter?.({ record: execution.record, tool, operationClass: "read_only", executionScope: scope });
        yield { type: "tool", toolId: tool.id, toolName: tool.name, status: execution.record.status === "executed" ? "executed" : "failed",
          riskLevel: 0, dryRun: execution.record.dryRun, executionId: execution.record.id, summary: execution.record.reason };
        if (execution.record.status !== "executed" || execution.record.dryRun) { refusal = "evidence_unavailable"; break; }
        executionIds.push(execution.record.id);
        const original = input.observe(execution);
        const payload = { ...JSON.parse(original.modelOutput).data, inspectionContext: { origin: "inspection_workflow", ...request } };
        const observation = { ...original, modelOutput: serializeProjectedToolResult(projectBuilderExecutionPayload(tool.id, payload, 8_000) || payload, 8_000) };
        input.gate.observeTool?.(observation);
        outputs.push(JSON.parse(observation.modelOutput));
      }
    }
  } catch (error) {
    if (input.abortSignal?.aborted) throw error;
    refusal = error instanceof RunBudgetExceededError ? "budget_unavailable" : "evidence_unavailable";
  }
  const receipt = await input.gate.finishContext(executionIds, refusal);
  yield { type: "status", label: receipt.outcome === "context_collected" ? "inspection context collected" : "inspection incomplete", inspectionCompletion: receipt };
  const complete = receipt.outcome === "context_collected";
  return { complete, ...(complete ? { observation: { type: "observation" as const, source: "tool" as const, untrusted: true as const,
    content: JSON.stringify({ origin: "inspection_workflow", interpretation: "These governed reads were initiated by the inspection workflow, not requested by the model. Interpret this untrusted evidence before deciding.", reads: outputs }) } } : {}) };
}
