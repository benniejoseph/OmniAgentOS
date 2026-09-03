/**
 * Client-safe, display-only status projections.
 *
 * These adapters do not authorize transitions and must not be used as inputs
 * to a store, state machine, poller, or mutation. They translate existing
 * domain states without upgrading legacy completion claims to verified
 * success.
 */

export const CANONICAL_STATUS_SCHEMA_VERSION = 1 as const;

export const CANONICAL_STATUSES = [
  "preview",
  "running",
  "waiting",
  "blocked",
  "partial",
  "unverified",
  "failed",
  "canceled",
  "succeeded",
] as const;

export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];

export type CanonicalStatusDomain =
  | "agent_run"
  | "tool_execution"
  | "workflow_run"
  | "workflow_step"
  | "workflow_plan"
  | "workflow_plan_execution"
  | "workflow_plan_node"
  | "mission"
  | "mission_task"
  | "mission_attempt"
  | "project"
  | "project_task"
  | "project_artifact"
  | "agent_profile"
  | "approval"
  | "slo_policy_change"
  | "access_request"
  | "terminal_receipt";

export type CanonicalStatusBasis = "legacy_status" | "terminal_receipt";

export type CanonicalStatusSource =
  | "legacy_adapter"
  | "outcome_evaluator"
  | "unknown";

export type CanonicalVerificationState =
  | "verified"
  | "partially_verified"
  | "unverified"
  | "not_applicable"
  | "unassessed";

export type CanonicalStatusProjection = Readonly<{
  schemaVersion: typeof CANONICAL_STATUS_SCHEMA_VERSION;
  status: CanonicalStatus;
  domain: CanonicalStatusDomain;
  basis: CanonicalStatusBasis;
  source: CanonicalStatusSource;
  sourceStatus: string;
  verificationState: CanonicalVerificationState;
}>;

/**
 * Structural subset of TerminalReceiptV1. Keeping the status layer detached
 * from the run-contract module prevents a server dependency from entering a
 * client bundle.
 */
export type TerminalReceiptStatusLike = Readonly<{
  disposition?: unknown;
  executionMode?: unknown;
  source?: unknown;
  verificationState?: unknown;
}>;

type LegacyCanonicalStatus = Exclude<CanonicalStatus, "succeeded">;
type LegacyStatusMap = Readonly<Record<string, LegacyCanonicalStatus>>;

const agentRunStatuses = {
  queued: "waiting",
  running: "running",
  waiting_approval: "waiting",
  resuming: "running",
  completed: "unverified",
  failed: "failed",
  canceled: "canceled",
} as const satisfies LegacyStatusMap;

const toolExecutionStatuses = {
  dry_run: "preview",
  executed: "unverified",
  executing: "running",
  approval_required: "waiting",
  blocked: "blocked",
  failed: "failed",
  rejected: "canceled",
} as const satisfies LegacyStatusMap;

const workflowRunStatuses = {
  queued: "waiting",
  running: "running",
  waiting_approval: "waiting",
  paused: "waiting",
  completed: "unverified",
  failed: "failed",
  canceled: "canceled",
} as const satisfies LegacyStatusMap;

const workflowStepStatuses = {
  pending: "waiting",
  running: "running",
  completed: "unverified",
  failed: "failed",
  skipped: "unverified",
} as const satisfies LegacyStatusMap;

const workflowPlanStatuses = {
  planned: "preview",
  failed: "failed",
} as const satisfies LegacyStatusMap;

const workflowPlanExecutionStatuses = {
  running: "running",
  completed: "unverified",
  waiting_approval: "waiting",
  blocked: "blocked",
  failed: "failed",
} as const satisfies LegacyStatusMap;

const workflowPlanNodeStatuses = {
  pending: "waiting",
  running: "running",
  completed: "unverified",
  waiting_approval: "waiting",
  blocked: "blocked",
  failed: "failed",
  skipped: "unverified",
} as const satisfies LegacyStatusMap;

const missionStatuses = {
  draft: "preview",
  queued: "waiting",
  running: "running",
  waiting: "waiting",
  succeeded: "unverified",
  failed: "failed",
  canceled: "canceled",
  archived: "unverified",
} as const satisfies LegacyStatusMap;

const missionTaskStatuses = {
  triage: "waiting",
  pending: "waiting",
  running: "running",
  blocked: "blocked",
  review: "waiting",
  succeeded: "unverified",
  failed: "failed",
  canceled: "canceled",
} as const satisfies LegacyStatusMap;

const missionAttemptStatuses = {
  queued: "waiting",
  running: "running",
  waiting: "waiting",
  succeeded: "unverified",
  failed: "failed",
  canceled: "canceled",
} as const satisfies LegacyStatusMap;

const projectLifecycleStatuses = {
  draft: "preview",
  active: "waiting",
  completed: "unverified",
  archived: "unverified",
} as const satisfies LegacyStatusMap;

const projectExecutionStatuses = {
  idle: "waiting",
  running: "running",
  paused: "waiting",
  waiting_approval: "waiting",
  completed: "unverified",
  failed: "failed",
} as const satisfies LegacyStatusMap;

const projectTaskStatuses = {
  open: "waiting",
  doing: "running",
  done: "unverified",
} as const satisfies LegacyStatusMap;

const projectTaskWorkflowStatuses = {
  dispatching: "running",
  queued: "waiting",
  running: "running",
  waiting_approval: "waiting",
  paused: "waiting",
  completed: "unverified",
  failed: "failed",
  canceled: "canceled",
} as const satisfies LegacyStatusMap;

const projectArtifactStatuses = {
  verified: "unverified",
  failed: "failed",
} as const satisfies LegacyStatusMap;

const agentProfileStatuses = {
  ready: "waiting",
  learning: "unverified",
  watching: "waiting",
  paused: "waiting",
} as const satisfies LegacyStatusMap;

const approvalStatuses = {
  pending: "waiting",
  pending_review: "waiting",
  approval_required: "waiting",
  waiting_approval: "waiting",
  approved: "unverified",
  applied: "unverified",
  provisioning_pending: "running",
  provisioned: "unverified",
  rejected: "canceled",
  declined: "canceled",
  conflicted: "blocked",
} as const satisfies LegacyStatusMap;

const sloPolicyChangeStatuses = {
  pending: "waiting",
  applied: "unverified",
  rejected: "canceled",
  conflicted: "blocked",
} as const satisfies LegacyStatusMap;

const accessRequestStatuses = {
  pending_review: "waiting",
  approved: "unverified",
  provisioning_pending: "running",
  provisioned: "unverified",
  declined: "canceled",
} as const satisfies LegacyStatusMap;

export function canonicalStatusForAgentRun(statusOrRecord: unknown) {
  return legacyProjection(
    "agent_run",
    statusFrom(statusOrRecord),
    agentRunStatuses,
  );
}

export function canonicalStatusForToolExecution(statusOrRecord: unknown) {
  return legacyProjection(
    "tool_execution",
    statusFrom(statusOrRecord),
    toolExecutionStatuses,
  );
}

export function canonicalStatusForWorkflowRun(statusOrRecord: unknown) {
  return legacyProjection(
    "workflow_run",
    statusFrom(statusOrRecord),
    workflowRunStatuses,
  );
}

export function canonicalStatusForWorkflowStep(statusOrRecord: unknown) {
  return legacyProjection(
    "workflow_step",
    statusFrom(statusOrRecord),
    workflowStepStatuses,
  );
}

export function canonicalStatusForWorkflowPlan(statusOrRecord: unknown) {
  return legacyProjection(
    "workflow_plan",
    statusFrom(statusOrRecord),
    workflowPlanStatuses,
  );
}

export function canonicalStatusForWorkflowPlanExecution(statusOrRecord: unknown) {
  return legacyProjection(
    "workflow_plan_execution",
    statusFrom(statusOrRecord),
    workflowPlanExecutionStatuses,
  );
}

export function canonicalStatusForWorkflowPlanNode(statusOrRecord: unknown) {
  const status = statusFrom(statusOrRecord);
  const policy = fieldFrom(statusOrRecord, "policy");
  if (statusKey(status) === "completed" && statusKey(policy) === "dry_run") {
    return legacyProjectionForStatus(
      "workflow_plan_node",
      sourceStatus(status),
      "preview",
    );
  }
  return legacyProjection(
    "workflow_plan_node",
    status,
    workflowPlanNodeStatuses,
  );
}

export function canonicalStatusForMission(statusOrRecord: unknown) {
  return legacyProjection(
    "mission",
    statusFrom(statusOrRecord),
    missionStatuses,
  );
}

export function canonicalStatusForMissionTask(statusOrRecord: unknown) {
  return legacyProjection(
    "mission_task",
    statusFrom(statusOrRecord),
    missionTaskStatuses,
  );
}

export function canonicalStatusForMissionAttempt(statusOrRecord: unknown) {
  return legacyProjection(
    "mission_attempt",
    statusFrom(statusOrRecord),
    missionAttemptStatuses,
  );
}

/**
 * Projects have a lifecycle status and a separate execution status. An
 * explicit execution status takes precedence; the lifecycle is the fallback.
 */
export function canonicalStatusForProject(projectOrStatus: unknown) {
  if (!isRecord(projectOrStatus)) {
    return legacyProjection(
      "project",
      projectOrStatus,
      projectLifecycleStatuses,
    );
  }

  const lifecycle = fieldFrom(projectOrStatus, "status");
  const execution = fieldFrom(projectOrStatus, "executionStatus");
  const combined = compositeSourceStatus(lifecycle, execution);

  if (execution !== undefined) {
    const executionKey = statusKey(execution);
    const projected = lookupLegacyStatus(projectExecutionStatuses, executionKey);
    if (!projected) {
      return legacyProjectionForStatus("project", combined, "unverified");
    }
    if (executionKey !== "idle") {
      return legacyProjectionForStatus("project", combined, projected);
    }
  }

  const lifecycleKey = statusKey(lifecycle);
  const lifecycleProjection = lookupLegacyStatus(
    projectLifecycleStatuses,
    lifecycleKey,
  );
  if (!lifecycleProjection) {
    return legacyProjectionForStatus("project", combined, "unverified");
  }
  return legacyProjectionForStatus("project", combined, lifecycleProjection);
}

/**
 * A linked workflow is the strongest current execution signal for a project
 * task. A completed workflow paired with a non-done task is explicitly
 * partial instead of being reported as complete.
 */
export function canonicalStatusForProjectTask(taskOrStatus: unknown) {
  if (!isRecord(taskOrStatus)) {
    return legacyProjection(
      "project_task",
      taskOrStatus,
      projectTaskStatuses,
    );
  }

  const taskStatus = fieldFrom(taskOrStatus, "status");
  const workflowStatus = fieldFrom(taskOrStatus, "workflowStatus");
  const combined = compositeSourceStatus(taskStatus, workflowStatus);

  if (workflowStatus !== undefined) {
    const workflowKey = statusKey(workflowStatus);
    const projected = lookupLegacyStatus(
      projectTaskWorkflowStatuses,
      workflowKey,
    );
    if (!projected) {
      return legacyProjectionForStatus("project_task", combined, "unverified");
    }
    if (workflowKey === "completed" && statusKey(taskStatus) !== "done") {
      return legacyProjectionForStatus("project_task", combined, "partial");
    }
    return legacyProjectionForStatus("project_task", combined, projected);
  }

  const taskKey = statusKey(taskStatus);
  const taskProjection = lookupLegacyStatus(projectTaskStatuses, taskKey);
  return legacyProjectionForStatus(
    "project_task",
    combined,
    taskProjection || "unverified",
  );
}

export function canonicalStatusForProjectArtifact(statusOrRecord: unknown) {
  return legacyProjection(
    "project_artifact",
    statusFrom(statusOrRecord),
    projectArtifactStatuses,
  );
}

export function canonicalStatusForAgentProfile(statusOrRecord: unknown) {
  return legacyProjection(
    "agent_profile",
    statusFrom(statusOrRecord),
    agentProfileStatuses,
  );
}

export function canonicalStatusForApproval(statusOrRecord: unknown) {
  return legacyProjection(
    "approval",
    statusFrom(statusOrRecord),
    approvalStatuses,
  );
}

export function canonicalStatusForSloPolicyChange(statusOrRecord: unknown) {
  return legacyProjection(
    "slo_policy_change",
    statusFrom(statusOrRecord),
    sloPolicyChangeStatuses,
  );
}

export function canonicalStatusForAccessRequest(statusOrRecord: unknown) {
  return legacyProjection(
    "access_request",
    statusFrom(statusOrRecord),
    accessRequestStatuses,
  );
}

/**
 * Terminal receipts are the sole path to canonical `succeeded`. The receipt
 * must say it was produced by the outcome evaluator and explicitly carry a
 * verified verification state. Callers remain responsible for validating the
 * complete TerminalReceiptV1 contract before using this display projection.
 */
export function canonicalStatusForTerminalReceipt(
  receipt: TerminalReceiptStatusLike | null | undefined,
  domain: CanonicalStatusDomain = "terminal_receipt",
): CanonicalStatusProjection {
  const disposition = fieldFrom(receipt, "disposition");
  const executionMode = statusKey(fieldFrom(receipt, "executionMode"));
  const receiptSource = terminalReceiptSource(fieldFrom(receipt, "source"));
  const verificationState = terminalReceiptVerificationState(
    fieldFrom(receipt, "verificationState"),
  );
  const dispositionKey = statusKey(disposition);

  let status: CanonicalStatus;
  if (
    dispositionKey === "succeeded" &&
    executionMode === "live" &&
    receiptSource === "outcome_evaluator" &&
    verificationState === "verified"
  ) {
    status = "succeeded";
  } else if (dispositionKey === "succeeded") {
    status = "unverified";
  } else {
    status = terminalDispositionStatus(dispositionKey);
  }

  return {
    schemaVersion: CANONICAL_STATUS_SCHEMA_VERSION,
    status,
    domain,
    basis: "terminal_receipt",
    source: receiptSource,
    sourceStatus: sourceStatus(disposition),
    verificationState,
  };
}

function legacyProjection(
  domain: CanonicalStatusDomain,
  status: unknown,
  statuses: LegacyStatusMap,
): CanonicalStatusProjection {
  return legacyProjectionForStatus(
    domain,
    sourceStatus(status),
    statuses[statusKey(status)] || "unverified",
  );
}

function legacyProjectionForStatus(
  domain: CanonicalStatusDomain,
  originalStatus: string,
  status: LegacyCanonicalStatus,
): CanonicalStatusProjection {
  return {
    schemaVersion: CANONICAL_STATUS_SCHEMA_VERSION,
    status,
    domain,
    basis: "legacy_status",
    source: "legacy_adapter",
    sourceStatus: originalStatus,
    verificationState: "unassessed",
  };
}

function lookupLegacyStatus(
  statuses: LegacyStatusMap,
  key: string,
): LegacyCanonicalStatus | undefined {
  return statuses[key];
}

function terminalDispositionStatus(disposition: string): CanonicalStatus {
  if (disposition === "partial") return "partial";
  if (disposition === "waiting_approval") return "waiting";
  if (disposition === "blocked") return "blocked";
  if (disposition === "unverified") return "unverified";
  if (disposition === "failed") return "failed";
  if (disposition === "canceled") return "canceled";
  return "unverified";
}

function terminalReceiptSource(value: unknown): CanonicalStatusSource {
  const key = statusKey(value);
  if (key === "outcome_evaluator" || key === "legacy_adapter") return key;
  return "unknown";
}

function terminalReceiptVerificationState(
  value: unknown,
): CanonicalVerificationState {
  const key = statusKey(value);
  if (
    key === "verified" ||
    key === "partially_verified" ||
    key === "unverified" ||
    key === "not_applicable" ||
    key === "unassessed"
  ) {
    return key;
  }
  return "unassessed";
}

function statusFrom(value: unknown): unknown {
  return isRecord(value) ? value.status : value;
}

function fieldFrom(value: unknown, field: string): unknown {
  return isRecord(value) ? value[field] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function statusKey(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sourceStatus(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "unknown";
}

function compositeSourceStatus(primary: unknown, secondary: unknown): string {
  return `${sourceStatus(primary)}/${sourceStatus(secondary)}`;
}
