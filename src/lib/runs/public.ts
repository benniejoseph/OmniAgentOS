import type { AgentRunRecord } from "@/lib/runs/types";
import { canonicalStatusForAgentRun } from "@/lib/status/canonical";

export function publicAgentRun(run: AgentRunRecord) {
  const { continuation, messages, ...safeRun } = run;
  return {
    ...safeRun,
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
