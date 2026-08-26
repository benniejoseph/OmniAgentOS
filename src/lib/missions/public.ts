import type { Mission, MissionDetail } from "@/lib/missions/types";

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

/**
 * A browser-safe Mission projection. Internal ownership keys, idempotency
 * source keys, executor fences, raw tool inputs/outputs, and artifact bodies
 * stay server-side unless a dedicated evidence endpoint is requested.
 */
export function toMissionDetailView(detail: MissionDetail) {
  const { mission } = detail;
  return {
    mission: toMissionSummaryView(mission),
    tasks: detail.tasks.map((task) => ({
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
      startedAt: task.startedAt,
      terminalAt: task.terminalAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    })),
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
    artifacts: detail.artifacts.map((artifact) => ({
      id: artifact.id,
      missionId: artifact.missionId,
      taskId: artifact.taskId,
      attemptId: artifact.attemptId,
      kind: artifact.kind,
      title: artifact.title,
      uri: artifact.uri,
      mimeType: artifact.mimeType,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    })),
  };
}

export type MissionDetailView = ReturnType<typeof toMissionDetailView>;
