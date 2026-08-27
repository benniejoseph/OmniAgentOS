import type {
  WorkflowRunStatus,
  WorkflowSignalType,
} from "@/lib/workflows/types";

export type WorkflowControlRun = {
  id: string;
  goal: string;
  status: WorkflowRunStatus;
};

const CONTROL_SIGNALS: Record<WorkflowRunStatus, WorkflowSignalType[]> = {
  queued: ["pause", "cancel"],
  running: ["pause", "cancel"],
  waiting_approval: ["approve", "cancel"],
  paused: ["resume", "cancel"],
  completed: [],
  failed: ["retry"],
  canceled: [],
};

const RUN_STATUSES = new Set<WorkflowRunStatus>([
  "queued",
  "running",
  "waiting_approval",
  "paused",
  "completed",
  "failed",
  "canceled",
]);

export function workflowControlSignals(
  status: WorkflowRunStatus,
): WorkflowSignalType[] {
  return [...CONTROL_SIGNALS[status]];
}

export function workflowControlRunsFrom(value: unknown): WorkflowControlRun[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const goal = typeof record.goal === "string" ? record.goal.trim() : "";
    const status =
      typeof record.status === "string" ? record.status : "";
    if (!id || !RUN_STATUSES.has(status as WorkflowRunStatus)) return [];
    return [{ id, goal: goal || "Workflow run", status: status as WorkflowRunStatus }];
  });
}

export function workflowControlHint(status: WorkflowRunStatus): string {
  if (status === "waiting_approval") {
    return "This run is already paused at an approval gate. Approve it to continue or cancel it to stop.";
  }
  if (status === "paused") {
    return "This run can be resumed or canceled.";
  }
  if (status === "failed") {
    return "This failed run can be retried from its failed step.";
  }
  if (status === "queued" || status === "running") {
    return "This active run can be paused or canceled.";
  }
  return "This run is finished and has no available controls.";
}

export function workflowSignalLabel(signal: WorkflowSignalType): string {
  return signal[0].toUpperCase() + signal.slice(1);
}
