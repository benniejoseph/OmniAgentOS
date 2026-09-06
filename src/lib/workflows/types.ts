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

export type WorkflowPlanNodeKind =
  | "research"
  | "tool"
  | "approval"
  | "execute"
  | "verify"
  | "memory"
  | "report";

export type WorkflowPlanPolicy = "auto" | "dry_run" | "approval_required" | "manual";

export type WorkflowPlanNodeExecutor = "agent" | "tool" | "control";

export type WorkflowPlanNodeContract = {
  schemaVersion: 1;
  executor: WorkflowPlanNodeExecutor;
  dependencyNodeIds: string[];
  grantedToolIds: string[];
  maxToolCalls: number;
  maxModelCalls: 0 | 1;
  maxOutputChars: number;
};

export type WorkflowPlanNodeInputBinding = {
  dependencyNodeId: string;
  targetToolId: string;
  /** Restricted JSON Pointer into the governed tool input. */
  targetPath: string;
  /** Empty selects all typed artifacts from the dependency. */
  artifactName: string;
};

export type WorkflowPlanNode = {
  id: string;
  label: string;
  kind: WorkflowPlanNodeKind;
  description: string;
  dependsOn: string[];
  toolIds: string[];
  toolInputs?: Array<{
    toolId: string;
    inputJson: string;
  }>;
  inputBindings?: WorkflowPlanNodeInputBinding[];
  connectorTargets: string[];
  riskLevel: 0 | 1 | 2 | 3;
  approvalRequired: boolean;
  policy: WorkflowPlanPolicy;
  acceptanceCriteria: string[];
  expectedOutputs: string[];
  /** Server-derived after planning. Older persisted plans are upgraded at execution. */
  execution?: WorkflowPlanNodeContract;
};

export type WorkflowPlanEdge = {
  from: string;
  to: string;
  condition: string;
};

export type WorkflowDynamicPlan = {
  objective: string;
  summary: string;
  mode: "orchestrate" | "research" | "execute" | "learn";
  assumptions: string[];
  constraints: string[];
  risks: string[];
  acceptanceCriteria: string[];
  nodes: WorkflowPlanNode[];
  edges: WorkflowPlanEdge[];
  selectedToolIds: string[];
  connectorTargets: string[];
  executionPolicy: {
    highestRiskLevel: 0 | 1 | 2 | 3;
    requiresApproval: boolean;
    defaultPolicy: WorkflowPlanPolicy;
    notes: string[];
  };
  verificationPlan: string[];
  memoryPlan: string[];
  confidence: number;
};

export type WorkflowPlanValidation = {
  isDag: boolean;
  missingDependencies: string[];
  unreachableNodes: string[];
  policyWarnings: string[];
};

export type WorkflowPlanRecord = {
  id: string;
  tenantId?: string;
  workflowRunId?: string;
  goal: string;
  status: "planned" | "failed";
  planner: "openai" | "google" | "anthropic" | "aws_bedrock" | "deterministic";
  model: string;
  plan: WorkflowDynamicPlan;
  validation: WorkflowPlanValidation;
  contextTraceId?: string;
  highestRiskLevel: 0 | 1 | 2 | 3;
  approvalRequired: boolean;
  confidence: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowPlanNodeExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "waiting_approval"
  | "blocked"
  | "failed"
  | "skipped";

export type WorkflowPlanNodeExecutionRecord = {
  id: string;
  tenantId?: string;
  workflowRunId: string;
  planId: string;
  nodeId: string;
  nodeLabel: string;
  nodeKind: WorkflowPlanNodeKind;
  status: WorkflowPlanNodeExecutionStatus;
  policy: WorkflowPlanPolicy;
  riskLevel: 0 | 1 | 2 | 3;
  approvalRequired: boolean;
  toolExecutionIds: string[];
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowPlanExecutionSummary = {
  workflowRunId: string;
  planId: string;
  status: "running" | "completed" | "waiting_approval" | "blocked" | "failed";
  totalNodes: number;
  completedNodes: number;
  blockedNodes: number;
  failedNodes: number;
  skippedNodes: number;
  waitingApprovalNodes: number;
  toolExecutions: number;
  dryRunTools: number;
  executedTools: number;
  approvalRequiredTools: number;
  toolCalls: number;
  costUnits: number;
  elapsedMs: number;
  highestRiskLevel: 0 | 1 | 2 | 3;
  nodeExecutions: WorkflowPlanNodeExecutionRecord[];
};

export type WorkflowRunInput = {
  goal: string;
  mode?: "orchestrate" | "research" | "execute" | "learn";
  planId?: string;
  requireApproval?: boolean;
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
  /** Internal fail-closed marker; public request schemas never accept it. */
  executionAuthorityRequired?: true;
};

export type WorkflowRunRecord = {
  id: string;
  tenantId?: string;
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
  tenantId?: string;
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
  tenantId?: string;
  workflowRunId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type WorkflowRecoveryEventRecord = WorkflowEventRecord & {
  disposition: "requeued" | "failed";
  workflow: {
    id: string;
    goal: string;
    status: WorkflowRunStatus;
    currentStep?: WorkflowStepKey;
    attempt: number;
    maxAttempts: number;
    error?: string;
  };
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

export type WorkflowPlanStats = {
  total: number;
  byStatus: Record<string, number>;
  approvalRequired: number;
  highRisk: number;
  averageConfidence: number;
  latest: WorkflowPlanRecord[];
};

export type WorkflowPlanNodeExecutionStats = {
  total: number;
  byStatus: Record<string, number>;
  approvalRequired: number;
  blocked: number;
  failed: number;
  dryRunTools: number;
  executedTools: number;
  latest: WorkflowPlanNodeExecutionRecord[];
};

export type WorkflowTriggerStatus = "active" | "paused";

export type WorkflowTriggerAuthMode = "none" | "hmac_sha256";

export type WorkflowTriggerRecord = {
  id: string;
  tenantId: string;
  name: string;
  source: string;
  status: WorkflowTriggerStatus;
  authMode: WorkflowTriggerAuthMode;
  secretEnvVar?: string;
  goalTemplate: string;
  workflowMode: WorkflowRunInput["mode"];
  requireApproval: boolean;
  metadata: Record<string, unknown>;
  triggerCount: number;
  failureCount: number;
  lastTriggeredAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowTriggerEventStatus = "accepted" | "rejected" | "enqueued" | "failed";

export type WorkflowTriggerEventRecord = {
  id: string;
  tenantId: string;
  triggerId: string;
  deliveryKey?: string;
  signatureDigest?: string;
  status: WorkflowTriggerEventStatus;
  source: string;
  eventType?: string;
  signatureVerified: boolean;
  workflowRunId?: string;
  queueJobId?: string;
  payload: Record<string, unknown>;
  headers: Record<string, unknown>;
  error?: string;
  receivedAt: string;
};

export type WorkflowTriggerStats = {
  total: number;
  active: number;
  byStatus: Record<string, number>;
  events: number;
  acceptedEvents: number;
  rejectedEvents: number;
  enqueuedEvents: number;
  failedEvents: number;
  latestTriggers: WorkflowTriggerRecord[];
  latestEvents: WorkflowTriggerEventRecord[];
};
