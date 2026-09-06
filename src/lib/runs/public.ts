import type { AgentRunRecord } from "@/lib/runs/types";
import { publicGroundingReport } from "@/lib/rag/citations";
import {
  canonicalStatusForAgentRun,
  canonicalStatusForTerminalReceipt,
} from "@/lib/status/canonical";

export function publicAgentRun(run: AgentRunRecord) {
  const { continuation, grounding, messages, ownerActorId: _ownerActorId, ...safeRun } = run;
  void _ownerActorId;
  return {
    ...safeRun,
    grounding: grounding ? publicGroundingReport(grounding) : undefined,
    canonicalStatus: run.terminalReceipt
      ? canonicalStatusForTerminalReceipt(run.terminalReceipt, "agent_run")
      : canonicalStatusForAgentRun(run),
    messageCount: messages.length,
    waitingApproval: continuation
      ? {
          executionId: continuation.pendingToolCall.executionId,
          toolId: continuation.pendingToolCall.toolId,
          toolName: continuation.pendingToolCall.toolName,
          riskLevel: continuation.pendingToolCall.riskLevel,
        }
      : undefined,
  };
}
