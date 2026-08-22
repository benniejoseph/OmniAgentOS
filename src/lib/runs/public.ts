import type { AgentRunRecord } from "@/lib/runs/types";

export function publicAgentRun(run: AgentRunRecord) {
  const { continuation, messages, ...safeRun } = run;
  return {
    ...safeRun,
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
