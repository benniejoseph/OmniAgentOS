import {
  findMissionAttemptByExecutor,
  getMissionDetail,
  getMissionTask,
  MissionConflictError,
  MissionTransitionError,
  recordMissionArtifact,
  startMissionAttempt,
  transitionMission,
  transitionMissionAttempt,
  transitionMissionTask,
} from "@/lib/missions/store";
import type {
  Mission,
  MissionAttempt,
  MissionAttemptStatus,
  MissionStatus,
  MissionTask,
  MissionTaskStatus,
} from "@/lib/missions/types";
import { redactSensitive } from "@/lib/security/context";

type MissionOwner = { tenantId?: string; actorId: string };
type ExecutorStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "canceled";

const TERMINAL_ATTEMPT_STATUSES = new Set<MissionAttemptStatus>([
  "succeeded",
  "failed",
  "canceled",
]);
const TERMINAL_TASK_STATUSES = new Set<MissionTaskStatus>([
  "succeeded",
  "failed",
  "canceled",
]);
const TERMINAL_MISSION_STATUSES = new Set<MissionStatus>([
  "succeeded",
  "failed",
  "canceled",
  "archived",
]);

export async function attachMissionExecutor(input: {
  taskId: string;
  executorType: "agent_run" | "workflow_run";
  executorId: string;
  status?: "queued" | "running";
  payload?: Record<string, unknown>;
}, owner: MissionOwner) {
  const attempt = await startMissionAttempt(input.taskId, {
    executorKey: `${input.executorType}:${input.executorId}`,
    executorType: input.executorType,
    executorId: input.executorId,
    agentRunId: input.executorType === "agent_run" ? input.executorId : undefined,
    workflowRunId: input.executorType === "workflow_run" ? input.executorId : undefined,
    input: input.payload,
  }, owner);
  if ((input.status || "queued") === "running") {
    await applyMissionExecutorStatus(attempt, "running", {}, owner);
  }
  return attempt;
}

export async function syncMissionExecutor(input: {
  executorType: "agent_run" | "workflow_run";
  executorId: string;
  status: ExecutorStatus;
  output?: Record<string, unknown>;
  error?: string;
}, owner: MissionOwner) {
  const attempt = await findMissionAttemptByExecutor(
    input.executorType,
    input.executorId,
    owner,
  );
  if (!attempt) return undefined;
  return applyMissionExecutorStatus(attempt, input.status, {
    output: input.output,
    error: input.error,
  }, owner);
}

export async function syncMissionExecutorSafely(input: {
  executorType: "agent_run" | "workflow_run";
  executorId: string;
  status: ExecutorStatus;
  output?: Record<string, unknown>;
  error?: string;
}, owner: MissionOwner) {
  try {
    return await syncMissionExecutor(input, owner);
  } catch (error) {
    console.error(
      "Mission executor synchronization failed.",
      String(redactSensitive(error instanceof Error ? error.message : error)).slice(0, 1_000),
    );
    return undefined;
  }
}

async function applyMissionExecutorStatus(
  attempt: MissionAttempt,
  status: ExecutorStatus,
  patch: { output?: Record<string, unknown>; error?: string },
  owner: MissionOwner,
) {
  let updated = attempt;
  if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
    if (status === "queued") return attempt;
    updated = await transitionMissionAttempt(attempt.id, status, {
      fenceToken: attempt.fenceToken,
      output: patch.output,
      error: patch.error,
      agentRunId: attempt.agentRunId,
      workflowRunId: attempt.workflowRunId,
    }, owner);
  }

  // The attempt is the durable source of truth. A retry after its terminal
  // write must finish task, artifact, and mission reconciliation rather than
  // returning early and leaving a permanently partial projection.
  const effectiveStatus = updated.status;
  const task = await getMissionTask(updated.taskId, owner);
  if (!task) return updated;
  await reconcileTaskFromAttempt(task, effectiveStatus, owner);

  if (effectiveStatus === "succeeded") {
    await recordMissionArtifact({
      ...owner,
      missionId: updated.missionId,
      taskId: updated.taskId,
      attemptId: updated.id,
      sourceKey: `attempt:${updated.id}:result`,
      kind: "execution_receipt",
      title: `${task.title} · result`,
      data: updated.output || { verified: true },
    });
  }
  await reconcileMissionFromTasks(updated.missionId, owner);
  return updated;
}

async function reconcileTaskFromAttempt(
  task: MissionTask,
  attemptStatus: MissionAttemptStatus,
  owner: MissionOwner,
) {
  if (attemptStatus === "queued") return task;
  let latest = task;
  for (let pass = 0; pass < 4; pass += 1) {
    if (TERMINAL_TASK_STATUSES.has(latest.status)) return latest;
    const nextStatus = nextTaskStatus(latest.status, attemptStatus);
    if (!nextStatus || nextStatus === latest.status) return latest;
    try {
      latest = await transitionMissionTask(latest.id, nextStatus, owner);
    } catch (error) {
      if (!(error instanceof MissionConflictError) && !(error instanceof MissionTransitionError)) {
        throw error;
      }
      const raced = await getMissionTask(latest.id, owner);
      if (!raced) return undefined;
      latest = raced;
    }
  }
  return latest;
}

function nextTaskStatus(
  current: MissionTaskStatus,
  attemptStatus: MissionAttemptStatus,
): MissionTaskStatus | undefined {
  if (TERMINAL_TASK_STATUSES.has(current) || attemptStatus === "queued") return undefined;
  if (attemptStatus === "running") return current === "running" ? undefined : "running";
  if (attemptStatus === "waiting") {
    if (current === "pending") return "running";
    return current === "running" ? "blocked" : undefined;
  }
  if (attemptStatus === "succeeded" && current === "blocked") return "running";
  return attemptStatus;
}

async function reconcileMissionFromTasks(missionId: string, owner: MissionOwner) {
  for (let pass = 0; pass < 8; pass += 1) {
    const detail = await getMissionDetail(missionId, owner);
    if (!detail) return undefined;
    const { mission, tasks } = detail;
    if (TERMINAL_MISSION_STATUSES.has(mission.status)) return mission;
    const target = deriveMissionStatus(mission, tasks);
    if (target === mission.status) return mission;
    const nextStatus = nextMissionStatus(mission.status, target);
    try {
      await transitionMission(mission.id, nextStatus, owner);
    } catch (error) {
      if (!(error instanceof MissionConflictError) && !(error instanceof MissionTransitionError)) {
        throw error;
      }
    }
  }
  throw new MissionConflictError("Mission status could not be reconciled after concurrent updates.");
}

function deriveMissionStatus(mission: Mission, tasks: MissionTask[]): MissionStatus {
  if (!tasks.length) return mission.status;
  if (tasks.every((task) => TERMINAL_TASK_STATUSES.has(task.status))) {
    if (tasks.some((task) => task.status === "failed")) return "failed";
    if (tasks.some((task) => task.status === "canceled")) return "canceled";
    return "succeeded";
  }
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.some((task) => task.status === "pending")) {
    const workStarted = tasks.some((task) => task.status !== "pending");
    if (workStarted || mission.status === "running" || mission.status === "waiting") {
      return "running";
    }
    return mission.status;
  }
  if (tasks.some((task) => task.status === "blocked")) return "waiting";
  return mission.status;
}

function nextMissionStatus(current: MissionStatus, target: MissionStatus): MissionStatus {
  if (current === target || TERMINAL_MISSION_STATUSES.has(current)) return current;
  if (current === "draft") {
    if (["queued", "running", "canceled", "archived"].includes(target)) return target;
    return "running";
  }
  if (current === "queued" && target === "succeeded") return "running";
  return target;
}
