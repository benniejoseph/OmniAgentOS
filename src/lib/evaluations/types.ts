export type EvalCaseType = "system" | "retrieval" | "tool" | "workflow" | "security" | "operations";
export type EvalRunStatus = "running" | "completed" | "failed";
export type EvalResultStatus = "pass" | "fail" | "warn";
export type EvalSafetyMode = "read_only" | "synthetic" | "mutation_allowed";
export type EvalCleanupPolicy = "none" | "self_cleaning" | "audit_retained" | "manual_review";

export type EvalCaseGovernance = {
  safetyMode: EvalSafetyMode;
  riskLevel: 0 | 1 | 2 | 3;
  writesToDatabase: boolean;
  cleanup: EvalCleanupPolicy;
  production: {
    allowedByDefault: boolean;
    requiresAdmin: boolean;
    requiresMutationApproval: boolean;
  };
  notes: string[];
};

export type EvalCaseDefinition = {
  id: string;
  name: string;
  description: string;
  type: EvalCaseType;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  governance: EvalCaseGovernance;
};

export type EvalRunSummary = {
  total: number;
  passed: number;
  failed: number;
  warnings: number;
  averageLatencyMs: number;
  estimatedCostUsd: number;
};

export type EvalRunRecord = {
  id: string;
  suite: string;
  status: EvalRunStatus;
  summary: EvalRunSummary;
  error?: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type EvalResultRecord = {
  id: string;
  evalRunId: string;
  caseId: string;
  caseName: string;
  caseType: EvalCaseType;
  status: EvalResultStatus;
  score: number;
  latencyMs: number;
  estimatedCostUsd: number;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  createdAt: string;
};

export type EvalRunDetail = {
  run: EvalRunRecord;
  results: EvalResultRecord[];
};

export type EvalLedger = {
  runs: EvalRunRecord[];
  results: EvalResultRecord[];
};

export type EvalStats = {
  total: number;
  byStatus: Record<string, number>;
  latest?: EvalRunRecord;
  latestPassRate: number;
  averageLatencyMs: number;
  estimatedCostUsd: number;
};
