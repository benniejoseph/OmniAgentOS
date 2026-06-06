export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export type WorkflowStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type WorkflowSignalType = "pause" | "resume" | "cancel" | "approve" | "retry";

export type WorkflowStepKey =
  | "preflight"
  | "retrieve_context"
  | "plan"
  | "approval_gate"
  | "execute"
  | "verify"
  | "persist_report";

export type WorkflowRunInput = {
  goal: string;
  mode?: "orchestrate" | "research" | "execute" | "learn";
  requireApproval?: boolean;
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
};

export type WorkflowRunRecord = {
  id: string;
  workflowType: string;
  status: WorkflowRunStatus;
  goal: string;
  input: WorkflowRunInput;
  currentStep?: WorkflowStepKey;
  attempt: number;
  maxAttempts: number;
  approvalRequired: boolean;
  approvedAt?: string;
  pausedAt?: string;
  canceledAt?: string;
  error?: string;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type WorkflowStepRecord = {
  id: string;
  workflowRunId: string;
  stepKey: WorkflowStepKey;
  label: string;
  status: WorkflowStepStatus;
  attempt: number;
  maxAttempts: number;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowEventRecord = {
  id: string;
  workflowRunId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type WorkflowRunDetail = {
  run: WorkflowRunRecord;
  steps: WorkflowStepRecord[];
  events: WorkflowEventRecord[];
};

export type WorkflowLedger = {
  runs: WorkflowRunRecord[];
  steps: WorkflowStepRecord[];
  events: WorkflowEventRecord[];
};

export type WorkflowStats = {
  total: number;
  byStatus: Record<string, number>;
  active: number;
  waitingApproval: number;
  latest: WorkflowRunRecord[];
};
