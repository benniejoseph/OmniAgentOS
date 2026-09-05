import type { AgentRunRecord } from "@/lib/runs/types";
import { publicGroundingReport } from "@/lib/rag/citations";
import { canonicalStatusForAgentRun } from "@/lib/status/canonical";

export function publicAgentRun(run: AgentRunRecord) {
  const { continuation, grounding, messages, ...safeRun } = run;
  return {
    ...safeRun,
    grounding: grounding ? publicGroundingReport(grounding) : undefined,
    canonicalStatus: canonicalStatusForAgentRun(run),
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
