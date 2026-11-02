import type { AgentRunContinuation } from "@/lib/runs/types";
import type { AgentMode } from "@/lib/orchestration/modes";

type AgentToolPolicy = NonNullable<AgentRunContinuation["toolPolicy"]>;

export function resolveAgentToolPolicy(input: {
  allowedToolIds: readonly string[];
  approvalPolicy: "always" | "risk_based" | "read_only";
  autonomy: "assist" | "governed" | "execute";
  mode?: AgentMode;
}): AgentToolPolicy {
  const readOnly = input.approvalPolicy === "read_only" ||
    input.autonomy === "assist" || input.mode === "chat";
  const forceApprovalForWrites = input.approvalPolicy === "always";
  return {
    allowedToolIds: [...input.allowedToolIds],
    readOnly,
    forceApproval: false,
    ...(forceApprovalForWrites ? { forceApprovalAboveRisk: 0 } : {}),
  };
}
