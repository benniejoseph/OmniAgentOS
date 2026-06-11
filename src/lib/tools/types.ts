export type ToolRiskLevel = 0 | 1 | 2 | 3;

export type ToolExecutionStatus =
  | "dry_run"
  | "executed"
  | "approval_required"
  | "blocked"
  | "failed"
  | "rejected";

export type ToolDefinition = {
  id: string;
  name: string;
  description: string;
  category: "memory" | "knowledge" | "runs" | "web" | "connector" | "mcp" | "openapi";
  status: "active" | "planned";
  riskLevel: ToolRiskLevel;
  dryRunSupported: boolean;
  approvalRequired: boolean;
  inputSchema: Record<string, unknown>;
};

export type ToolQuorumApproval = {
  by: string;
  role: string;
  at: string;
  reason?: string;
};

export const RISK3_QUORUM = 2;

export type ToolExecutionRecord = {
  id: string;
  tenantId?: string;
  actorId?: string;
  toolId: string;
  toolName: string;
  riskLevel: ToolRiskLevel;
  status: ToolExecutionStatus;
  dryRun: boolean;
  approvalRequired: boolean;
  input: Record<string, unknown>;
  output?: unknown;
  reason?: string;
  approvalDecision?: "approved" | "rejected";
  /** Risk-3 quorum: distinct admin approvals collected so far. */
  approvals?: ToolQuorumApproval[];
  approvedBy?: string;
  approvedAt?: string;
  approvalReason?: string;
  createdAt: string;
  completedAt?: string;
};

export type ToolExecutionLedger = {
  records: ToolExecutionRecord[];
};
