import { createHash } from "node:crypto";
import { z } from "zod";
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
  createMission,
  ensureMissionTask,
  getMissionDetail,
  getMissionSummaryForRequest,
  getMissionTask,
  listMissions,
  listMissionSummariesForRequest,
} from "@/lib/missions/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import type { CanonicalStatus } from "@/lib/status/canonical";
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
