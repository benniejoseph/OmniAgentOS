import type { RunBudgetCountersV1 } from "@/lib/runs/budgets";
import type { AgentRunIdentityPinV1 } from "@/lib/agents/identity-contracts";
import type { WorkflowPlanContextBoundaryV1 } from "@/lib/workflows/shared-context";
import type {
  WorkflowCommandContextBoundaryV1,
  WorkflowCommandModelBoundaryV1,
} from "@/lib/workflows/command-context";

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

export type WorkflowReplanTrigger =
  | "assumption"
  | "observation"
  | "tool"
  | "verification";

export type WorkflowReusedNodeReferenceV1 = {
  nodeId: string;
  executionId: string;
  sourcePlanId: string;
  nodeSha256: string;
  outputSha256: string;
};

export type WorkflowReplanDirectiveV1 = {
  schemaVersion: 1;
  previousPlanId: string;
  previousPlanSha256: string;
  trigger: WorkflowReplanTrigger;
  failureNodeIds: string[];
  affectedNodeIds: string[];
  reusedNodes: WorkflowReusedNodeReferenceV1[];
  approvalInvalidated: boolean;
  contextGrantsInvalidated: true;
  capabilityGrantsInvalidated: true;
  previousContextTraceId?: string;
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
  /** Server-derived lineage for one bounded material subtree replan. */
  replan?: WorkflowReplanDirectiveV1;
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
  /** Content-free server-derived shared-context authority bound at planning. */
  contextBoundary?: WorkflowPlanContextBoundaryV1;
  /** Content-free exact Command reference boundary; hydrated content is never persisted. */
  commandContextBoundary?: WorkflowCommandContextBoundaryV1;
  /** Content-free exact per-command model selection boundary. */
  commandModelBoundary?: WorkflowCommandModelBoundaryV1;
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
  budgetLimits?: RunBudgetCountersV1;
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

export type WorkflowTriggerKind = "webhook" | "schedule";

export type WorkflowScheduleMissedPolicy = "skip" | "run_once";

export type WorkflowScheduleCircuitState = "closed" | "open" | "half_open";

export type WorkflowScheduleProcedurePinV1 = Readonly<{
  schemaVersion: 1;
  procedureId: string;
  snapshotSha256: string;
  reviewedSnapshotSha256: string;
  reviewedAt: string;
}>;

export type WorkflowScheduleAuthorityMode =
  | "read_only"
  | "reviewed_mutation";

export type WorkflowScheduleMutationBindingV1 = Readonly<{
  schemaVersion: 1;
  bindingIndex: number;
  toolId: string;
  inputSha256: string;
  targetSha256: string;
  toolContractSha256: string;
  riskLevel: 1 | 2;
  reversible: true;
  bindingSha256: string;
}>;

/**
 * Standing schedule authority is review evidence, not an execution token.
 * Every occurrence still requires a short-lived, single-use PolicyLeaseV1.
 */
export type WorkflowScheduleMutationPolicyV1 = Readonly<{
  schemaVersion: 1;
  policyKind: "reviewed_static_mutation";
  procedureSnapshotSha256: string;
  agentIdentityPinSha256: string;
  agentPolicyPinSha256: string;
  occurrenceBudgetSha256: string;
  maximumOccurrences: number;
  bindings: readonly WorkflowScheduleMutationBindingV1[];
  policySha256: string;
}>;

export type WorkflowScheduleConfigV1 = Readonly<{
  schemaVersion: 1;
  timezone: string;
  rrule: string;
  startsAt: string;
  endsAt?: string;
  maxOccurrences: number;
  missedPolicy: WorkflowScheduleMissedPolicy;
  procedurePin: WorkflowScheduleProcedurePinV1;
  agentIdentityPin: AgentRunIdentityPinV1;
  policyPinSha256: string;
  occurrenceBudget: RunBudgetCountersV1;
  failureLimit: number;
  authorityMode?: WorkflowScheduleAuthorityMode;
  mutationPolicy?: WorkflowScheduleMutationPolicyV1;
  configSha256: string;
}>;

export type WorkflowScheduleStateV1 = Readonly<{
  nextDueAt?: string;
  occurrenceCount: number;
  consecutiveFailureCount: number;
  circuitState: WorkflowScheduleCircuitState;
  pausedReason?: string;
  lastFailureAt?: string;
  circuitOpenedAt?: string;
  shadowNextDueAt?: string;
  shadowOccurrenceCount: number;
  shadowEvaluatedAt?: string;
}>;

export type WorkflowScheduleShadowOutcome =
  | "due"
  | "missed_run_once"
  | "missed_skipped"
  | "exhausted";

export type WorkflowScheduleShadowReceiptV1 = Readonly<{
  schemaVersion: 1;
  id: string;
  tenantId: string;
  ownerActorId: string;
  triggerId: string;
  scheduledFor: string;
  evaluatedThrough: string;
  outcome: WorkflowScheduleShadowOutcome;
  wouldCreateRun: boolean;
  occurrencesConsumed: number;
  occurrenceCount: number;
  nextDueAt?: string;
  configurationSha256: string;
  agentIdentityPinSha256: string;
  policyPinSha256: string;
  procedureSnapshotSha256: string;
  reviewedSnapshotSha256: string;
  occurrenceBudgetSha256: string;
  evaluatedAt: string;
  receiptSha256: string;
}>;

export type WorkflowScheduleOccurrenceKind = "scheduled" | "manual";

export type WorkflowScheduleOccurrenceStatus =
  | "claimed"
  | "enqueued"
  | "completed"
  | "skipped"
  | "failed";

export type WorkflowScheduleOccurrenceFailureCode =
  | "agent_identity_changed"
  | "agent_policy_changed"
  | "procedure_changed"
  | "procedure_not_read_only"
  | "mutation_policy_changed"
  | "policy_lease_unavailable"
  | "occurrence_budget_changed"
  | "workflow_enqueue_failed"
  | "workflow_failed"
  | "workflow_canceled";

export type WorkflowScheduleOccurrenceRecord = Readonly<{
  schemaVersion: 1;
  id: string;
  tenantId: string;
  ownerActorId: string;
  triggerId: string;
  kind: WorkflowScheduleOccurrenceKind;
  status: WorkflowScheduleOccurrenceStatus;
  scheduledFor: string;
  evaluatedThrough: string;
  outcome: WorkflowScheduleShadowOutcome;
  occurrencesConsumed: number;
  occurrenceCount: number;
  nextDueAt?: string;
  configurationSha256: string;
  agentIdentityPinSha256: string;
  policyPinSha256: string;
  procedureSnapshotSha256: string;
  reviewedSnapshotSha256: string;
  occurrenceBudgetSha256: string;
  authoritySha256: string;
  workflowRunId?: string;
  queueJobId?: string;
  failureCode?: WorkflowScheduleOccurrenceFailureCode;
  attemptCount: number;
  lastAttemptAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type WorkflowScheduleOccurrenceReceiptV1 = Readonly<{
  schemaVersion: 1;
  id: string;
  tenantId: string;
  ownerActorId: string;
  triggerId: string;
  occurrenceId: string;
  status: WorkflowScheduleOccurrenceStatus;
  workflowRunId?: string;
  queueJobId?: string;
  failureCode?: WorkflowScheduleOccurrenceFailureCode;
  authoritySha256: string;
  stateSha256: string;
  recordedAt: string;
  receiptSha256: string;
}>;

export type WorkflowTriggerRecord = {
  id: string;
  tenantId: string;
  triggerKind: WorkflowTriggerKind;
  ownerActorId?: string;
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
  replacesTriggerId?: string;
  replacedByTriggerId?: string;
  schedule?: Readonly<{
    config: WorkflowScheduleConfigV1;
    state: WorkflowScheduleStateV1;
  }>;
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
