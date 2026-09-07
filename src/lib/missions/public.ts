import type {
  Mission,
  MissionArtifact,
  MissionDetail,
  MissionTask,
  RequestMissionSummary,
} from "@/lib/missions/types";
import {
  parseDelegationMessageV1,
  parseSharedMissionArtifactV1,
} from "@/lib/delegation/channel";
import {
  canonicalStatusForMission,
  canonicalStatusForMissionAttempt,
  canonicalStatusForMissionTask,
} from "@/lib/status/canonical";
import type { CanonicalWorkItemStatusView } from "@/lib/workspaces/read-model";

export function toMissionSummaryView(mission: Mission): RequestMissionSummary {
  return {
    id: mission.id,
    title: mission.title,
    objective: mission.objective,
    status: mission.status,
    canonicalStatus: canonicalStatusForMission(mission),
    priority: mission.priority,
    source: mission.source,
    startedAt: mission.startedAt,
    terminalAt: mission.terminalAt,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    detailAvailable: true,
    manageable: true,
    runnable: true,
  };
}

export type MissionSummaryView = RequestMissionSummary & {
  workItemStatus?: CanonicalWorkItemStatusView;
};

export function toMissionTaskView(task: MissionTask) {
  return {
    id: task.id,
    missionId: task.missionId,
    parentTaskId: task.parentTaskId,
    title: task.title,
    instructions: task.instructions,
    definitionOfDone: task.definitionOfDone,
    status: task.status,
    canonicalStatus: canonicalStatusForMissionTask(task),
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

export type MissionTaskView = ReturnType<typeof toMissionTaskView> & {
  workItemStatus?: CanonicalWorkItemStatusView;
};

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
      canonicalStatus: canonicalStatusForMissionAttempt(attempt),
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

type BaseMissionDetailView = ReturnType<typeof toMissionDetailView>;
export type MissionDetailView = Omit<BaseMissionDetailView, "mission" | "tasks"> & {
  mission: MissionSummaryView;
  tasks: MissionTaskView[];
};

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
  } else if (kind === "delegation_message") {
    return publicDelegationMessage(data.protocol);
  } else if (kind === "delegation_shared_artifact") {
    return publicDelegationArtifact(data.protocol);
  } else {
    return undefined;
  }
  return view;
}

function publicDelegationMessage(protocol: unknown) {
  try {
    const message = parseDelegationMessageV1(protocol);
    return {
      schemaVersion: message.schemaVersion,
      version: message.version,
      messageId: message.messageId,
      messageSha256: message.messageSha256,
      parentExecutionId: message.parentExecutionId,
      parentDelegationId: message.parentDelegationId,
      sender: publicChannelSender(message.sender),
      recipients: message.recipients,
      kind: message.kind,
      body: message.body,
      bodySha256: message.bodySha256,
      artifactReferences: message.artifactReferences,
      inReplyToMessageId: message.inReplyToMessageId,
      createdAt: message.createdAt,
      boundary: message.boundary,
    };
  } catch {
    return undefined;
  }
}

function publicDelegationArtifact(protocol: unknown) {
  try {
    const artifact = parseSharedMissionArtifactV1(protocol);
    return {
      schemaVersion: artifact.schemaVersion,
      version: artifact.version,
      artifactId: artifact.artifactId,
      artifactSha256: artifact.artifactSha256,
      parentExecutionId: artifact.parentExecutionId,
      parentDelegationId: artifact.parentDelegationId,
      sender: publicChannelSender(artifact.sender),
      recipients: artifact.recipients,
      kind: artifact.kind,
      title: artifact.title,
      mediaType: artifact.mediaType,
      content: artifact.content,
      contentSha256: artifact.contentSha256,
      byteCount: artifact.byteCount,
      evidenceIds: artifact.evidenceIds,
      toolExecutionIds: artifact.toolExecutionIds,
      createdAt: artifact.createdAt,
      boundary: artifact.boundary,
    };
  } catch {
    return undefined;
  }
}

function publicChannelSender(sender: {
  taskId: string;
  delegationId: string;
  agentId: string;
  definitionVersion: number;
}) {
  return {
    taskId: sender.taskId,
    delegationId: sender.delegationId,
    agentId: sender.agentId,
    definitionVersion: sender.definitionVersion,
  };
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
