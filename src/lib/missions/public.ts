import type {
  Mission,
  MissionArtifact,
  MissionDetail,
  MissionTask,
} from "@/lib/missions/types";

export function toMissionSummaryView(mission: Mission) {
  return {
    id: mission.id,
    title: mission.title,
    objective: mission.objective,
    status: mission.status,
    priority: mission.priority,
    source: mission.source,
    startedAt: mission.startedAt,
    terminalAt: mission.terminalAt,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

export type MissionSummaryView = ReturnType<typeof toMissionSummaryView>;

export function toMissionTaskView(task: MissionTask) {
  return {
    id: task.id,
    missionId: task.missionId,
    parentTaskId: task.parentTaskId,
    title: task.title,
    instructions: task.instructions,
    definitionOfDone: task.definitionOfDone,
    status: task.status,
    priority: task.priority,
    position: task.position,
    dependencyIds: task.dependencyIds,
    metadata: publicTaskMetadata(task.metadata || {}),
    startedAt: task.startedAt,
    terminalAt: task.terminalAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export type MissionTaskView = ReturnType<typeof toMissionTaskView>;

export function toMissionArtifactView(artifact: MissionArtifact) {
  const publicData = publicArtifactData(artifact.kind, artifact.data);
  return {
    id: artifact.id,
    missionId: artifact.missionId,
    taskId: artifact.taskId,
    attemptId: artifact.attemptId,
    kind: artifact.kind,
    title: artifact.title,
    uri: artifact.uri,
    mimeType: artifact.mimeType,
    ...(publicData ? { data: publicData } : {}),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

export type MissionArtifactView = ReturnType<typeof toMissionArtifactView>;

/**
 * A browser-safe Mission projection. Internal ownership keys, idempotency
 * source keys, executor fences, raw tool inputs/outputs, and artifact bodies
 * stay server-side unless a dedicated evidence endpoint is requested.
 */
export function toMissionDetailView(detail: MissionDetail) {
  const { mission } = detail;
  return {
    mission: toMissionSummaryView(mission),
    tasks: detail.tasks.map(toMissionTaskView),
    attempts: detail.attempts.map((attempt) => ({
      id: attempt.id,
      missionId: attempt.missionId,
      taskId: attempt.taskId,
      executorType: attempt.executorType,
      status: attempt.status,
      agentRunId: attempt.agentRunId,
      workflowRunId: attempt.workflowRunId,
      error: attempt.error,
      startedAt: attempt.startedAt,
      terminalAt: attempt.terminalAt,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
    })),
    artifacts: detail.artifacts.map(toMissionArtifactView),
  };
}

export type MissionDetailView = ReturnType<typeof toMissionDetailView>;

function publicTaskMetadata(metadata: Record<string, unknown>) {
  const view: Record<string, unknown> = {};
  copyText(view, metadata, "assigneeKey", 200);
  copyText(view, metadata, "assigneeName", 160);
  copyText(view, metadata, "scheduledAt", 80);
  copyBoolean(view, metadata, "reviewRequired");
  copyText(view, metadata, "reviewerKey", 200);
  copyText(view, metadata, "reviewerName", 160);
  copyText(view, metadata, "reviewRequestedAt", 80);
  copyText(view, metadata, "reviewSummary", 4_000);
  copyText(view, metadata, "changesRequestedReason", 4_000);
  if (Array.isArray(metadata.skillIds)) {
    view.skillIds = metadata.skillIds
      .filter((value): value is string => typeof value === "string")
      .slice(0, 50)
      .map((value) => value.slice(0, 240));
  }
  if (metadata.blocker && typeof metadata.blocker === "object" && !Array.isArray(metadata.blocker)) {
    const blocker = metadata.blocker as Record<string, unknown>;
    if (
      typeof blocker.kind === "string" &&
      ["dependency", "needs_input", "capability", "transient"].includes(blocker.kind) &&
      typeof blocker.reason === "string"
    ) {
      view.blocker = { kind: blocker.kind, reason: blocker.reason.slice(0, 4_000) };
    }
  }
  return view;
}

function publicArtifactData(kind: string, data: Record<string, unknown>) {
  const view: Record<string, unknown> = {};
  if (kind === "task_comment") {
    copyText(view, data, "body", 8_000);
  } else if (kind === "task_handoff") {
    copyText(view, data, "summary", 8_000);
    copyText(view, data, "verification", 4_000);
    copyText(view, data, "recovery", 4_000);
    copyText(view, data, "residualRisk", 4_000);
    if (Array.isArray(data.artifactIds)) {
      view.artifactIds = data.artifactIds
        .filter((value): value is string => typeof value === "string")
        .slice(0, 50)
        .map((value) => value.slice(0, 240));
    }
  } else if (["review_request", "review_approval", "review_changes_requested"].includes(kind)) {
    copyText(view, data, "action", 40);
    copyText(view, data, "summary", 4_000);
    copyText(view, data, "reason", 4_000);
    copyText(view, data, "reviewerKey", 200);
    copyText(view, data, "reviewerName", 160);
    copyText(view, data, "requestedAt", 80);
  } else {
    return undefined;
  }
  return view;
}

function copyText(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
  max: number,
) {
  if (typeof source[key] === "string") target[key] = source[key].slice(0, max);
}

function copyBoolean(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
) {
  if (typeof source[key] === "boolean") target[key] = source[key];
}
