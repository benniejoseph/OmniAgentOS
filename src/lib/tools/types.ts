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
  approvedBy?: string;
  approvedAt?: string;
  approvalReason?: string;
  createdAt: string;
  completedAt?: string;
};

export type ToolExecutionLedger = {
  records: ToolExecutionRecord[];
};
