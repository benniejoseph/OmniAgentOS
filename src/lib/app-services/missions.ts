import { createHash } from "node:crypto";
import { z } from "zod";
import { resolveAgentIdentityForExecution } from "@/lib/agents/identity-store";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  toMissionArtifactView,
  toMissionDetailView,
  toMissionSummaryView,
  toMissionTaskView,
} from "@/lib/missions/public";
import {
  appendMissionTaskComment,
  assertMissionTaskReadyForExecution,
  createMission,
  ensureMissionTask,
  getMissionDetail,
  getMissionSummaryForRequest,
  getMissionTask,
  listMissions,
  listMissionSummariesForRequest,
  MissionConflictError,
  MissionTransitionError,
} from "@/lib/missions/store";
import { attachMissionExecutor } from "@/lib/missions/runtime";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { listAgentSkills } from "@/lib/skills/store";
import type { CanonicalStatus } from "@/lib/status/canonical";
import { enqueueWorkflowRunTick, scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import {
  createWorkflowRun,
  deterministicWorkflowRunId,
  getWorkflowRunDetail,
} from "@/lib/workflows/store";
import {
  missionProjectId,
  missionRootWorkItemId,
} from "@/lib/workspaces/legacy-projection";
import { canonicalWorkItemStatuses } from "@/lib/workspaces/read-model";

const missionStatusSchema = z.enum([
  "draft",
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
  "archived",
]);

export const missionListServiceInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  status: missionStatusSchema.optional(),
  ownerScope: z.enum(["exact", "readable"]).default("exact"),
}).strict();

export const missionShowServiceInputSchema = z.object({
  missionId: z.string().uuid(),
  view: z.enum(["detail", "readable_summary"]).default("detail"),
  tasks: z.number().int().min(1).max(200).default(30),
  attempts: z.number().int().min(1).max(200).default(100),
  artifacts: z.number().int().min(1).max(200).default(50),
}).strict();

export const missionCreateServiceInputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  objective: z.string().trim().min(1).max(4_000),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
}).strict();

const blockerSchema = z.object({
  kind: z.enum(["dependency", "needs_input", "capability", "transient"]),
  reason: z.string().trim().min(1).max(4_000),
}).strict();

export const missionTaskCreateServiceInputSchema = z.object({
  missionId: z.string().uuid(),
  sourceKey: z.string().trim().min(1).max(240).optional(),
  title: z.string().trim().min(1).max(280),
  instructions: z.string().trim().max(8_000).optional(),
  definitionOfDone: z.string().trim().max(2_000).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  position: z.number().int().min(0).max(100_000).optional(),
  parentTaskId: z.string().trim().min(1).max(240).optional(),
  dependencyIds: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
  status: z.enum(["triage", "pending"]).default("triage"),
  assigneeId: z.string().trim().min(1).max(200).optional(),
  assigneeKey: z.string().trim().min(1).max(200).optional(),
  assigneeName: z.string().trim().min(1).max(160).optional(),
  skillIds: z.array(z.string().trim().min(1).max(240)).max(50).optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  blocker: blockerSchema.optional(),
  reviewRequired: z.boolean().optional(),
  reviewerKey: z.string().trim().min(1).max(200).optional(),
  reviewerName: z.string().trim().min(1).max(160).optional(),
}).strict();

export const missionTaskCommentServiceInputSchema = z.object({
  missionId: z.string().uuid(),
  taskId: z.string().uuid(),
  body: z.string().trim().min(1).max(8_000),
  sourceKey: z.string().trim().min(1).max(240).optional(),
}).strict();

export const missionTaskStartServiceInputSchema = z.object({
  missionId: z.string().uuid(),
  taskId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export async function listMissionsService(
  caller: AppServiceCaller,
  input: z.input<typeof missionListServiceInputSchema>,
) {
  const value = missionListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("missions.list"),
  );
  const owner = exactOwner(caller);
  const requestedLimit = value.status ? 200 : value.limit;
  const missions = value.ownerScope === "readable"
    ? await listMissionSummariesForRequest(requestedLimit, {
        ...owner,
        requestActorBinding:
          canonicalRequestActorBindingFromSecurityContext(caller.context),
      })
    : (await listMissions(requestedLimit, owner)).map(toMissionSummaryView);
  const filtered = missions
    .filter((mission) => !value.status || mission.status === value.status)
    .slice(0, value.limit);
  const canonicalMissions = await withCanonicalMissionSummaries(
    caller.context.tenantId,
    filtered,
  );
  return completeAppServiceCall(authorized, {
    missions: canonicalMissions,
    requestReadContracts: {
      missions: value.ownerScope === "readable" ? "readable_v1" : "exact_v1",
    },
  }, { resourceCount: filtered.length });
}

export async function showMissionService(
  caller: AppServiceCaller,
  input: z.input<typeof missionShowServiceInputSchema>,
) {
  const value = missionShowServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("missions.show"),
  );
  if (value.view === "readable_summary") {
    const mission = await getMissionSummaryForRequest(value.missionId, {
      ...exactOwner(caller),
      requestActorBinding:
        canonicalRequestActorBindingFromSecurityContext(caller.context),
    });
    const [canonicalMission] = mission
      ? await withCanonicalMissionSummaries(caller.context.tenantId, [mission])
      : [];
    return completeAppServiceCall(authorized, {
      mission: canonicalMission || null,
      requestReadContracts: { missionSummary: "readable_v1" as const },
    }, { resourceCount: mission ? 1 : 0 });
  }
  const detail = await getMissionDetail(
    value.missionId,
    exactOwner(caller),
    {
      tasks: value.tasks,
      attempts: value.attempts,
      artifacts: value.artifacts,
    },
  );
  return completeAppServiceCall(authorized, detail
    ? await withCanonicalMissionDetail(
        caller.context.tenantId,
        toMissionDetailView(detail),
      )
    : null, { resourceCount: detail ? 1 : 0 });
}

export async function createMissionService(
  caller: AppServiceCaller,
  input: z.input<typeof missionCreateServiceInputSchema>,
) {
  const value = redactSensitive(
    missionCreateServiceInputSchema.parse(input),
  ) as z.output<typeof missionCreateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("missions.create"),
  );
  const mission = await createMission({
    ...value,
    ...mutationOwner(caller),
    source: "user",
  });
  const [canonicalMission] = await withCanonicalMissionSummaries(
    caller.context.tenantId,
    [toMissionSummaryView(mission)],
  );
  return completeAppServiceCall(authorized, { mission: canonicalMission });
}

export async function createMissionTaskService(
  caller: AppServiceCaller,
  input: z.input<typeof missionTaskCreateServiceInputSchema>,
) {
  const value = redactSensitive(
    missionTaskCreateServiceInputSchema.parse(input),
  ) as z.output<typeof missionTaskCreateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("mission.task.create"),
  );
  const task = await ensureMissionTask(value.missionId, {
    sourceKey: serviceSourceKey(
      "task",
      value.missionId,
      value.sourceKey || caller.idempotencyKey!,
    ),
    title: value.title,
    instructions: value.instructions,
    definitionOfDone: value.definitionOfDone,
    priority: value.priority,
    position: value.position,
    parentTaskId: value.parentTaskId,
    dependencyIds: value.dependencyIds,
    status: value.status,
    metadata: {
      assigneeKey: value.assigneeKey || value.assigneeId,
      assigneeName: value.assigneeName,
      skillIds: value.skillIds,
      scheduledAt: value.scheduledAt,
      blocker: value.blocker,
      reviewRequired: value.reviewRequired,
      reviewerKey: value.reviewerKey,
      reviewerName: value.reviewerName,
    },
  }, mutationOwner(caller));
  const [canonicalTask] = await withCanonicalMissionTasks(
    caller.context.tenantId,
    [toMissionTaskView(task)],
  );
  return completeAppServiceCall(authorized, {
    task: canonicalTask,
    placement: value.status,
  });
}

export async function commentOnMissionTaskService(
  caller: AppServiceCaller,
  input: z.input<typeof missionTaskCommentServiceInputSchema>,
) {
  const value = redactSensitive(
    missionTaskCommentServiceInputSchema.parse(input),
  ) as z.output<typeof missionTaskCommentServiceInputSchema>;
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("mission.task.comment"),
  );
  const owner = mutationOwner(caller);
  const task = await getMissionTask(value.taskId, owner);
  if (!task || task.missionId !== value.missionId) {
    return completeAppServiceCall(authorized, { comment: null }, {
      resourceCount: 0,
    });
  }
  const comment = await appendMissionTaskComment(task.id, {
    body: value.body,
    sourceKey: serviceSourceKey(
      "comment",
      task.id,
      value.sourceKey || caller.idempotencyKey!,
    ),
  }, owner);
  return completeAppServiceCall(authorized, {
    comment: toMissionArtifactView(comment),
  });
}

export async function startMissionTaskService(
  caller: AppServiceCaller,
  input: z.input<typeof missionTaskStartServiceInputSchema>,
) {
  const value = missionTaskStartServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("mission.task.start"),
  );
  const owner = mutationOwner(caller);
  const task = await assertMissionTaskReadyForExecution(value.taskId, owner);
  if (task.missionId !== value.missionId) {
    return completeAppServiceCall(authorized, { execution: null }, {
      resourceCount: 0,
    });
  }
  if (value.expectedUpdatedAt && task.updatedAt !== value.expectedUpdatedAt) {
    throw new MissionConflictError("Mission task changed after it was loaded.");
  }
  const assigneeId = typeof task.metadata.assigneeKey === "string"
    ? task.metadata.assigneeKey.trim()
    : "";
  if (!assigneeId) {
    throw new MissionTransitionError(
      "Assign an Agent before starting governed execution.",
    );
  }

  const taskView = toMissionTaskView(task);
  const [workItemStatus, agentIdentity, skills] = await Promise.all([
    withCanonicalMissionTasks(caller.context.tenantId, [taskView])
      .then((items) => items[0].workItemStatus),
    resolveAgentIdentityForExecution({
      tenantId: caller.context.tenantId,
      actorId: caller.context.actorId,
      agentId: assigneeId,
    }),
    listAgentSkills(exactOwner(caller)),
  ]);
  if (
    workItemStatus.sourceAuthority !== "legacy_mission_task" ||
    workItemStatus.sourceId !== task.id ||
    workItemStatus.workItemId !== task.id ||
    workItemStatus.projectId !== missionProjectId(task.missionId)
  ) {
    throw new Error("Canonical WorkItem authority could not be verified.");
  }

  const workflowIdempotencyKey = `mission-task:${task.id}:${caller.idempotencyKey!}`;
  const workflowRunId = deterministicWorkflowRunId(
    caller.context.tenantId,
    workflowIdempotencyKey,
  );
  const attempt = await attachMissionExecutor({
    taskId: task.id,
    executorType: "workflow_run",
    executorId: workflowRunId,
    status: "queued",
    payload: {
      source: "canonical_work_item",
      workItemId: workItemStatus.workItemId,
      projectId: workItemStatus.projectId,
    },
  }, owner);
  if (attempt.executorId !== workflowRunId) {
    const activeRun = await getWorkflowRunDetail(attempt.executorId, {
      tenantId: caller.context.tenantId,
    });
    if (!activeRun) {
      throw new MissionConflictError(
        "Another governed execution is being initialized for this task.",
      );
    }
    return completeAppServiceCall(authorized, {
      execution: missionTaskExecutionView(task, attempt, activeRun.run.status),
    });
  }

  const selectedSkills = skills.filter((skill) =>
    agentIdentity.definition.declaredSkills.some((pin) => pin.skillId === skill.id)
  );
  const agentProfile = {
    name: agentIdentity.definition.name,
    role: agentIdentity.definition.role,
    description: agentIdentity.definition.description,
    instructions: agentIdentity.definition.instructions,
    persona: agentIdentity.definition.persona,
    modelPolicy: agentIdentity.definition.modelPolicy,
    autonomy: agentIdentity.principal.autonomy,
    approvalPolicy: agentIdentity.principal.approvalPolicy,
    memoryScope: agentIdentity.principal.memoryScope,
    toolIds: agentIdentity.principal.toolGrantIds,
    skills: selectedSkills.map(({ id, name, description, instructions, toolIds }) => ({
      id,
      name,
      description,
      instructions,
      toolIds,
    })),
  };
  const executionAuthority = {
    executionScope: executionScopeFromSecurityContext(caller.context, {
      executingPrincipalType: "agent",
      executingPrincipalId: agentIdentity.principal.principalId,
      workspaceId: workItemStatus.workspaceId,
      projectId: workItemStatus.projectId,
      missionId: task.missionId,
      causationId: task.id,
      correlationId: caller.executionScope!.correlationId,
      contextGrantIds: agentIdentity.principal.contextGrantIds,
      capabilityGrantIds: agentIdentity.principal.capabilityGrantIds,
      purpose: "mission.work_item.execute.v1",
    }),
    requesterRole: caller.context.role,
  } as const;
  const detail = await createWorkflowRun({
    tenantId: caller.context.tenantId,
    idempotencyKey: workflowIdempotencyKey,
    executionAuthority,
    goal: missionTaskExecutionGoal(task),
    mode: "execute",
    requireApproval: agentIdentity.principal.approvalPolicy === "always",
    metadata: {
      source: "mission_work_item",
      actorId: caller.context.actorId,
      missionId: task.missionId,
      missionTaskId: task.id,
      workItemId: workItemStatus.workItemId,
      workspaceId: workItemStatus.workspaceId,
      projectId: workItemStatus.projectId,
      primaryAgentId: assigneeId,
      agentProfile,
      agentIdentity,
      skillIds: selectedSkills.map((skill) => skill.id),
    },
  });
  if (
    detail.run.id !== workflowRunId ||
    detail.run.input.metadata?.missionTaskId !== task.id ||
    detail.run.input.metadata?.workItemId !== workItemStatus.workItemId
  ) {
    throw new Error("Governed workflow idempotency binding does not match this WorkItem.");
  }
  await enqueueWorkflowRunTick(
    detail.run.id,
    "mission_work_item_started",
    undefined,
    caller.context.tenantId,
  );
  scheduleWorkflowQueueDrain(undefined, caller.context.tenantId);
  return completeAppServiceCall(authorized, {
    execution: missionTaskExecutionView(task, attempt, detail.run.status),
  });
}

function exactOwner(caller: AppServiceCaller) {
  return {
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
  };
}

async function withCanonicalMissionSummaries<T extends {
  id: string;
  status: string;
  canonicalStatus: { status: CanonicalStatus; sourceStatus: string };
  updatedAt: string;
}>(tenantId: string, missions: readonly T[]) {
  const statuses = await canonicalWorkItemStatuses(
    tenantId,
    "legacy_mission",
    missions.map((mission) => ({
      projectId: missionProjectId(mission.id),
      workItemId: missionRootWorkItemId(mission.id),
      kind: "milestone" as const,
      sourceId: mission.id,
      status: mission.canonicalStatus.status,
      sourceStatus: mission.canonicalStatus.sourceStatus,
      updatedAt: mission.updatedAt,
    })),
  );
  return missions.map((mission) => ({
    ...mission,
    workItemStatus: statuses.get(mission.id)!,
  }));
}

async function withCanonicalMissionTasks<T extends {
  id: string;
  missionId: string;
  canonicalStatus: { status: CanonicalStatus; sourceStatus: string };
  updatedAt: string;
}>(tenantId: string, tasks: readonly T[]) {
  const statuses = await canonicalWorkItemStatuses(
    tenantId,
    "legacy_mission_task",
    tasks.map((task) => ({
      projectId: missionProjectId(task.missionId),
      workItemId: task.id,
      kind: "task" as const,
      sourceId: task.id,
      status: task.canonicalStatus.status,
      sourceStatus: task.canonicalStatus.sourceStatus,
      updatedAt: task.updatedAt,
    })),
  );
  return tasks.map((task) => ({
    ...task,
    workItemStatus: statuses.get(task.id)!,
  }));
}

async function withCanonicalMissionDetail(
  tenantId: string,
  detail: ReturnType<typeof toMissionDetailView>,
) {
  const [missions, tasks] = await Promise.all([
    withCanonicalMissionSummaries(tenantId, [detail.mission]),
    withCanonicalMissionTasks(tenantId, detail.tasks),
  ]);
  return { ...detail, mission: missions[0], tasks };
}

function mutationOwner(caller: AppServiceCaller) {
  if (!caller.executionScope || !caller.idempotencyKey) {
    throw new Error("Mission mutation service requires execution attribution.");
  }
  return {
    ...exactOwner(caller),
    executionScope: caller.executionScope,
    idempotencyKey: caller.idempotencyKey,
  };
}

function serviceSourceKey(
  kind: "task" | "comment",
  scopeId: string,
  identity: string,
) {
  return `app-service:${kind}:${createHash("sha256")
    .update(`${kind}\u0000${scopeId}\u0000${identity}`, "utf8")
    .digest("hex")}`;
}

function missionTaskExecutionGoal(task: {
  title: string;
  instructions: string;
  definitionOfDone: string;
}) {
  return [
    task.title,
    task.instructions ? `Instructions:\n${task.instructions}` : "",
    task.definitionOfDone
      ? `Definition of done:\n${task.definitionOfDone}`
      : "",
  ].filter(Boolean).join("\n\n").slice(0, 4_000);
}

function missionTaskExecutionView(
  task: { id: string; missionId: string },
  attempt: { id: string; executorType: string; executorId: string; status: string },
  workflowStatus: string,
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    authority: "governed_workflow_v1" as const,
    missionId: task.missionId,
    workItemId: task.id,
    attemptId: attempt.id,
    executorType: attempt.executorType,
    executorId: attempt.executorId,
    attemptStatus: attempt.status,
    executorStatus: workflowStatus,
  });
}
