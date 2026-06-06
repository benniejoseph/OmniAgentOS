export type EvalCaseType = "system" | "retrieval" | "tool" | "workflow" | "security" | "operations";
export type EvalRunStatus = "running" | "completed" | "failed";
export type EvalResultStatus = "pass" | "fail" | "warn";

export type EvalCaseDefinition = {
  id: string;
  name: string;
  description: string;
  type: EvalCaseType;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
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
