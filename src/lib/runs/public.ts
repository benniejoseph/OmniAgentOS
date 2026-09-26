import type { AgentEvent } from "@/lib/orchestration/types";
import type { AgentRunRecord } from "@/lib/runs/types";
import { publicGroundingReport } from "@/lib/rag/citations";
import { redactSensitive } from "@/lib/security/context";
import {
  canonicalStatusForAgentRun,
  canonicalStatusForTerminalReceipt,
} from "@/lib/status/canonical";

const RUN_CANCELED_MESSAGE = "The Agent run was canceled.";
const RUN_WAITING_APPROVAL_MESSAGE =
  "Run paused. Approval will resume this same agent run after the tool executes.";
const RUN_WAITING_CLARIFICATION_MESSAGE =
  "Name or identify the exact item you want changed before I continue.";

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

/**
 * The event that ends a client's view of a run in its stored state: the
 * answer, the failure, the cancellation, or the pause waiting on the owner.
 * A run still working has none. Grounding is the public projection, never the
 * raw claim evidence.
 */
export function agentRunOutcomeEvent(
  run: AgentRunRecord,
  options: { canceledMessage?: string } = {},
): AgentEvent | undefined {
  if (run.status === "completed") {
    return {
      type: "done",
      response: run.response || "",
      ...(run.grounding
        ? { grounding: publicGroundingReport(run.grounding) }
        : {}),
    } as AgentEvent;
  }
  if (run.status === "failed") {
    return {
      type: "error",
      message: String(redactSensitive(run.error || "Agent run failed.")).slice(
        0,
        1_000,
      ),
    };
  }
  if (run.status === "canceled") {
    return {
      type: "canceled",
      message: options.canceledMessage || RUN_CANCELED_MESSAGE,
    };
  }
  const pendingToolCall = run.continuation?.pendingToolCall;
  if (run.status === "waiting_approval" && pendingToolCall) {
    return {
      type: "waiting_approval",
      executionId: pendingToolCall.executionId,
      toolId: pendingToolCall.toolId,
      message: RUN_WAITING_APPROVAL_MESSAGE,
    };
  }
  if (run.status === "waiting_clarification" && run.threadId) {
    return {
      type: "clarification",
      threadId: run.threadId,
      runId: run.id,
      message: run.response || RUN_WAITING_CLARIFICATION_MESSAGE,
      reasonCode: "ambiguous_read_target",
    };
  }
  return undefined;
}
