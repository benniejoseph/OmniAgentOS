import { RISK3_QUORUM, type ToolDefinition, type ToolRiskLevel } from "@/lib/tools/types";

export type ToolPolicyDecision = {
  allowed: boolean;
  approvalRequired: boolean;
  blocked: boolean;
  riskLevel: ToolRiskLevel;
  reason: string;
};

export function evaluateToolPolicy({
  tool,
  approved,
}: {
  tool: ToolDefinition;
  approved?: boolean;
}): ToolPolicyDecision {
  if (tool.status !== "active") {
    return {
      allowed: false,
      approvalRequired: tool.approvalRequired,
      blocked: true,
      riskLevel: tool.riskLevel,
      reason: "Tool is not active.",
    };
  }

  if (tool.riskLevel >= 3) {
    return {
      allowed: Boolean(approved),
      approvalRequired: true,
      blocked: false,
      riskLevel: tool.riskLevel,
      reason: approved
        ? "Risk 3 quorum satisfied."
        : `Risk 3 tools require ${RISK3_QUORUM} distinct admin approvals (requester excluded).`,
    };
  }

  if (tool.approvalRequired || tool.riskLevel >= 2) {
    return {
      allowed: Boolean(approved),
      approvalRequired: true,
      blocked: false,
      riskLevel: tool.riskLevel,
      reason: approved ? "Approval supplied." : "Approval required before execution.",
    };
  }

  return {
    allowed: true,
    approvalRequired: false,
    blocked: false,
    riskLevel: tool.riskLevel,
    reason: tool.riskLevel === 0 ? "Read-only tool auto-allowed." : "Low-risk reversible tool auto-allowed.",
  };
}
