export type ToolRiskLevel = 0 | 1 | 2 | 3;

export type ToolExecutionStatus =
  | "dry_run"
  | "executed"
  | "approval_required"
  | "blocked"
  | "failed";

export type ToolDefinition = {
  id: string;
  name: string;
  description: string;
  category: "memory" | "knowledge" | "runs" | "connector";
  status: "active" | "planned";
  riskLevel: ToolRiskLevel;
  dryRunSupported: boolean;
  approvalRequired: boolean;
  inputSchema: Record<string, unknown>;
};

export type ToolExecutionRecord = {
  id: string;
  toolId: string;
  toolName: string;
  riskLevel: ToolRiskLevel;
  status: ToolExecutionStatus;
  dryRun: boolean;
  approvalRequired: boolean;
  input: Record<string, unknown>;
  output?: unknown;
  reason?: string;
  createdAt: string;
  completedAt?: string;
};

export type ToolExecutionLedger = {
  records: ToolExecutionRecord[];
};
