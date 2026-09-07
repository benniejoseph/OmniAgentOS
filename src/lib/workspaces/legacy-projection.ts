import type { Mission, MissionArtifact, MissionTask } from "@/lib/missions/types";
import type { PersonalProject, ProjectArtifact, ProjectTask } from "@/lib/projects/types";
import {
  canonicalStatusForMission,
  canonicalStatusForMissionTask,
  canonicalStatusForProjectTask,
} from "@/lib/status/canonical";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  parseCanonicalProjectV1,
  parseCanonicalWorkCompatibilityV1,
  parseCanonicalWorkItemV1,
  type CanonicalProjectV1,
  type CanonicalWorkCompatibilityV1,
  type CanonicalWorkItemV1,
} from "@/lib/workspaces/contracts";

type ProjectionAuthority = Readonly<{
  workspaceId: string;
  canonicalOwnerActorId: string;
}>;

export function projectCanonicalProjection(
  project: PersonalProject,
  authority: ProjectionAuthority,
  revision: number,
) {
  const projection = parseCanonicalProjectV1({
    schemaVersion: 1,
    tenantId: project.tenantId,
    workspaceId: authority.workspaceId,
    projectId: project.id,
    ownerActorId: authority.canonicalOwnerActorId,
    title: project.title,
    objective: project.objective,
    lifecycleStatus: project.status,
    sourceAuthority: "legacy_project",
    lifecycleRevision: revision,
    targetDate: project.targetDate || null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    completedAt: project.completedAt || null,
  });
  return withDigests(projection, projectSourceRevision(project));
}

export function projectTaskCanonicalProjection(
  project: PersonalProject,
  task: ProjectTask,
  artifacts: readonly ProjectArtifact[],
  authority: ProjectionAuthority,
  revision: number,
) {
  const status = canonicalStatusForProjectTask(task);
  const terminalAt = ["unverified", "failed", "canceled", "succeeded"].includes(status.status)
    ? task.completedAt || task.updatedAt
    : null;
  const projection = parseCanonicalWorkItemV1({
    schemaVersion: 1,
    tenantId: task.tenantId,
    workspaceId: authority.workspaceId,
    projectId: project.id,
    workItemId: task.id,
    parentWorkItemId: null,
    kind: "task",
    title: task.title,
    detail: task.detail,
    priority: task.priority,
    canonicalStatus: status.status,
    sourceStatus: status.sourceStatus,
    statusRevision: revision,
    sourceAuthority: "legacy_project_task",
    dependencyWorkItemIds: sortedUnique(task.dependsOn),
    ownerActorIds: [authority.canonicalOwnerActorId],
    assignedAgents: [{
      agentId: task.agentId,
      principalId: null,
      principalGeneration: null,
    }],
    schedule: { startsAt: null, dueAt: task.dueAt || null, timeZone: null },
    recurrence: null,
    risks: [],
    decisions: [],
    artifacts: artifacts
      .filter((artifact) => artifact.taskId === task.id)
      .map((artifact) => ({
        artifactId: artifact.id,
        kind: "project_artifact",
        evidenceRefIds: sortedUnique(artifact.evidenceRefs),
      }))
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    terminalAt,
  });
  return withDigests(projection, projectTaskSourceRevision(task, artifacts));
}

export function missionProjectCanonicalProjection(
  mission: Mission,
  authority: ProjectionAuthority,
  revision: number,
) {
  const terminal = ["succeeded", "failed", "canceled"].includes(mission.status);
  const lifecycleStatus: CanonicalProjectV1["lifecycleStatus"] = mission.status === "draft"
    ? "draft"
    : mission.status === "archived"
      ? "archived"
      : terminal
        ? "completed"
        : "active";
  const projection = parseCanonicalProjectV1({
    schemaVersion: 1,
    tenantId: mission.tenantId,
    workspaceId: authority.workspaceId,
    projectId: missionProjectId(mission.id),
    ownerActorId: authority.canonicalOwnerActorId,
    title: mission.title,
    objective: mission.objective,
    lifecycleStatus,
    sourceAuthority: "legacy_mission",
    lifecycleRevision: revision,
    targetDate: null,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    completedAt: terminal ? mission.terminalAt || mission.updatedAt : null,
  });
  return withDigests(projection, missionSourceRevision(mission));
}

export function missionRootCanonicalProjection(
  mission: Mission,
  authority: ProjectionAuthority,
  revision: number,
) {
  const status = canonicalStatusForMission(mission);
  const terminalAt = ["unverified", "failed", "canceled", "succeeded"].includes(status.status)
    ? mission.terminalAt || mission.updatedAt
    : null;
  const projection = parseCanonicalWorkItemV1({
    schemaVersion: 1,
    tenantId: mission.tenantId,
    workspaceId: authority.workspaceId,
    projectId: missionProjectId(mission.id),
    workItemId: missionRootWorkItemId(mission.id),
    parentWorkItemId: null,
    kind: "milestone",
    title: mission.title,
    detail: mission.objective,
    priority: mission.priority,
    canonicalStatus: status.status,
    sourceStatus: status.sourceStatus,
    statusRevision: revision,
    sourceAuthority: "legacy_mission",
    dependencyWorkItemIds: [],
    ownerActorIds: [authority.canonicalOwnerActorId],
    assignedAgents: [],
    schedule: { startsAt: mission.startedAt || null, dueAt: null, timeZone: null },
    recurrence: null,
    risks: [],
    decisions: [],
    artifacts: [],
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    terminalAt,
  });
  return withDigests(projection, missionSourceRevision(mission));
}

export function missionTaskCanonicalProjection(
  mission: Mission,
  task: MissionTask,
  artifacts: readonly MissionArtifact[],
  authority: ProjectionAuthority,
  revision: number,
) {
  const status = canonicalStatusForMissionTask(task);
  const terminalAt = ["unverified", "failed", "canceled", "succeeded"].includes(status.status)
    ? task.terminalAt || task.updatedAt
    : null;
  const scheduledAt = canonicalOptionalTimestamp(task.metadata.scheduledAt);
  const assigneeKey = boundedId(task.metadata.assigneeKey);
  const projection = parseCanonicalWorkItemV1({
    schemaVersion: 1,
    tenantId: task.tenantId,
    workspaceId: authority.workspaceId,
    projectId: missionProjectId(mission.id),
    workItemId: task.id,
    parentWorkItemId: task.parentTaskId || missionRootWorkItemId(mission.id),
    kind: "task",
    title: task.title,
    detail: task.instructions,
    priority: task.priority,
    canonicalStatus: status.status,
    sourceStatus: status.sourceStatus,
    statusRevision: revision,
    sourceAuthority: "legacy_mission_task",
    dependencyWorkItemIds: sortedUnique(task.dependencyIds),
    ownerActorIds: [authority.canonicalOwnerActorId],
    assignedAgents: assigneeKey ? [{
      agentId: assigneeKey,
      principalId: null,
      principalGeneration: null,
    }] : [],
    schedule: { startsAt: task.startedAt || null, dueAt: scheduledAt, timeZone: null },
    recurrence: null,
    risks: [],
    decisions: [],
    artifacts: artifacts
      .filter((artifact) => artifact.taskId === task.id)
      .map((artifact) => ({
        artifactId: artifact.id,
        kind: boundedId(artifact.kind) || "result",
        evidenceRefIds: [],
      }))
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    terminalAt,
  });
  return withDigests(projection, missionTaskSourceRevision(task, artifacts));
}

export function activeCompatibilityMapping(
  input: {
    sourceKind: CanonicalWorkCompatibilityV1["sourceKind"];
    sourceId: string;
    sourceOwnerActorId: string;
    sourceRevisionSha256: string;
    tenantId: string;
    workspaceId: string;
    projectId: string;
    workItemId: string | null;
    canonicalOwnerActorId: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
  },
) {
  return parseCanonicalWorkCompatibilityV1({
    schemaVersion: 1,
    tenantId: input.tenantId,
    mappingId: `work_compat:${canonicalJsonSha256({
      tenantId: input.tenantId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
    }).slice(0, 40)}`,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourceOwnerActorId: input.sourceOwnerActorId,
    canonicalOwnerActorId: input.canonicalOwnerActorId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    workItemId: input.workItemId,
    state: "active",
    quarantineCode: null,
    sourceRevisionSha256: input.sourceRevisionSha256,
    mappingRevision: input.revision,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
}

export function missionProjectId(missionId: string) {
  return `mission_project:${missionId}`;
}

export function missionRootWorkItemId(missionId: string) {
  return `mission_root:${missionId}`;
}

function projectSourceRevision(project: PersonalProject) {
  return canonicalJsonSha256({
    id: project.id,
    actorId: project.actorId,
    title: project.title,
    objective: project.objective,
    status: project.status,
    targetDate: project.targetDate || null,
    completedAt: project.completedAt || null,
    updatedAt: project.updatedAt,
  });
}

function projectTaskSourceRevision(
  task: ProjectTask,
  artifacts: readonly ProjectArtifact[],
) {
  return canonicalJsonSha256({
    id: task.id,
    title: task.title,
    detail: task.detail,
    status: task.status,
    priority: task.priority,
    agentId: task.agentId,
    dueAt: task.dueAt || null,
    dependsOn: sortedUnique(task.dependsOn),
    workflowRunId: task.workflowRunId || null,
    workflowStatus: task.workflowStatus || null,
    completedAt: task.completedAt || null,
    artifacts: artifacts
      .filter((artifact) => artifact.taskId === task.id)
      .map((artifact) => ({
        id: artifact.id,
        status: artifact.status,
        evidenceRefs: sortedUnique(artifact.evidenceRefs),
        updatedAt: artifact.updatedAt,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    updatedAt: task.updatedAt,
  });
}

function missionSourceRevision(mission: Mission) {
  return canonicalJsonSha256({
    id: mission.id,
    actorId: mission.actorId,
    title: mission.title,
    objective: mission.objective,
    status: mission.status,
    priority: mission.priority,
    startedAt: mission.startedAt || null,
    terminalAt: mission.terminalAt || null,
    updatedAt: mission.updatedAt,
  });
}

function missionTaskSourceRevision(
  task: MissionTask,
  artifacts: readonly MissionArtifact[],
) {
  return canonicalJsonSha256({
    id: task.id,
    parentTaskId: task.parentTaskId || null,
    title: task.title,
    instructions: task.instructions,
    status: task.status,
    priority: task.priority,
    dependencyIds: sortedUnique(task.dependencyIds),
    metadata: task.metadata,
    artifacts: artifacts
      .filter((artifact) => artifact.taskId === task.id)
      .map((artifact) => ({ id: artifact.id, kind: artifact.kind, updatedAt: artifact.updatedAt }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    terminalAt: task.terminalAt || null,
    updatedAt: task.updatedAt,
  });
}

function withDigests<T extends CanonicalProjectV1 | CanonicalWorkItemV1>(
  projection: T,
  sourceRevisionSha256: string,
) {
  return Object.freeze({
    projection,
    projectionSha256: canonicalJsonSha256(projection),
    sourceRevisionSha256,
  });
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function canonicalOptionalTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) || date.toISOString() !== value ? null : value;
}

function boundedId(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(normalized) && normalized.length <= 240
    ? normalized
    : null;
}
