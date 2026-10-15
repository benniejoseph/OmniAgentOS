import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  parseProjectMutationInput,
  PROJECT_OBJECTIVE_LIMIT,
  projectTextLengthMessage,
  WORK_ITEM_DETAIL_LIMIT,
} from "@/lib/app-services/project-validation";
import { decomposeProject } from "@/lib/projects/planner";
import { reflectOnProjectArtifact } from "@/lib/projects/reflection";
import {
  createProject,
  createProjectTasks,
  getProject,
  getOwnedProject,
  getOwnedProjectTask,
  listProjectArtifacts,
  listProjectCollections,
  listProjects,
  listProjectTasks,
  listOwnedProjectTasksPage,
  updateProject,
  updateProjectExecution,
  updateProjectTask,
} from "@/lib/projects/store";
import type { ProjectArtifact, ProjectTask } from "@/lib/projects/types";
import { projectTaskCommitmentFields, refineProjectTaskDeadlinePatch } from "@/lib/projects/task-commitments";
import { buildProjectCommitmentSummary } from "@/lib/projects/commitment-summary";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import { canonicalStatusForProjectTask } from "@/lib/status/canonical";
import { canonicalWorkItemSurfaces } from "@/lib/workspaces/read-model";

const projectStatusSchema = z.enum(["draft", "active", "completed", "archived"]);
const projectTaskStatusSchema = z.enum(["open", "doing", "done"]);
const projectTaskPrioritySchema = z.enum(["low", "medium", "high"]);
const projectAgentSchema = z.enum(["atlas", "scout", "forge", "sentinel", "mnemosyne"]);
const projectObjectiveSchema = z.string().trim().min(1).max(PROJECT_OBJECTIVE_LIMIT, {
  error: (issue) => projectTextLengthMessage("objective", typeof issue.input === "string" ? issue.input.length : undefined),
});
const workItemDetailSchema = z.string().trim().max(WORK_ITEM_DETAIL_LIMIT, {
  error: (issue) => projectTextLengthMessage("detail", typeof issue.input === "string" ? issue.input.length : undefined),
});

export const projectListServiceInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  status: projectStatusSchema.optional(),
}).strict();

export const projectShowServiceInputSchema = z.object({
  projectId: z.string().trim().min(1).max(200),
  taskLimit: z.number().int().min(1).max(200).default(100),
  artifactLimit: z.number().int().min(1).max(200).default(100),
}).strict();

export const projectInventoryServiceInputSchema = projectShowServiceInputSchema.extend({
  taskCursor: z.string().min(1).max(2_048).optional(),
  includeFullObjective: z.boolean().default(false),
});

export const projectCreateServiceInputSchema = z.object({
  title: z.string().trim().min(1).max(180),
  objective: projectObjectiveSchema,
  status: z.enum(["draft", "active"]).optional(),
  targetDate: z.string().datetime({ offset: true }).optional(),
}).strict();

export const projectUpdateServiceInputSchema = z.object({
  projectId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(180).optional(),
  objective: projectObjectiveSchema.optional(),
  status: projectStatusSchema.optional(),
  targetDate: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().refine(({ projectId: _projectId, ...change }) => Object.keys(change).length > 0, {
  message: "A project change is required.",
});

export const workItemCreateServiceInputSchema = z.object({
  projectId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(240),
  detail: workItemDetailSchema.optional(),
  priority: projectTaskPrioritySchema.default("medium"),
  agentId: projectAgentSchema.default("atlas"),
  dueAt: z.string().datetime({ offset: true }).optional(),
  ...projectTaskCommitmentFields,
}).strict().superRefine(refineProjectTaskDeadlinePatch);

export const workItemUpdateServiceInputSchema = z.object({
  projectId: z.string().trim().min(1).max(200),
  workItemId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(240).optional(),
  detail: workItemDetailSchema.optional(),
  status: projectTaskStatusSchema.optional(),
  priority: projectTaskPrioritySchema.optional(),
  agentId: projectAgentSchema.optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  ...projectTaskCommitmentFields,
}).strict().superRefine(refineProjectTaskDeadlinePatch).refine(({ projectId: _projectId, workItemId: _workItemId, ...change }) => Object.keys(change).length > 0, {
  message: "A work-item change is required.",
});

export const projectPlanServiceInputSchema = z.object({
  projectId: z.string().trim().min(1).max(200),
  context: z.string().trim().max(4_000).optional(),
}).strict();

const projectExecutionConfigurationFields = {
  autonomyMode: z.enum(["manual", "supervised", "autonomous"]),
  taskBudget: z.number().int().min(1).max(50),
  maxParallelTasks: z.number().int().min(1).max(3),
  requireApproval: z.boolean(),
};
export const projectExecutionServiceInputSchema = z.discriminatedUnion("action", [
  z.object({ projectId: z.string().trim().min(1).max(200), action: z.literal("configure"), ...projectExecutionConfigurationFields }).strict(),
  z.object({ projectId: z.string().trim().min(1).max(200), action: z.literal("start"), ...projectExecutionConfigurationFields, autonomyMode: z.enum(["supervised", "autonomous"]) }).strict(),
  z.object({ projectId: z.string().trim().min(1).max(200), action: z.enum(["pause", "resume", "sync"]) }).strict(),
  z.object({ projectId: z.string().trim().min(1).max(200), action: z.enum(["approve", "retry"]), workItemId: z.string().trim().min(1).max(200) }).strict(),
]);

export const projectArtifactFeedbackServiceInputSchema = z.object({
  projectId: z.string().trim().min(1).max(200), artifactId: z.string().trim().min(1).max(200),
  verdict: z.enum(["useful", "needs_work"]), lesson: z.string().trim().min(3).max(1_200),
}).strict();

export async function listProjectsService(
  caller: AppServiceCaller,
  input: z.input<typeof projectListServiceInputSchema>,
) {
  const value = projectListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.list"));
  const projects = await listProjects(value.status ? 100 : value.limit, readOwner(caller));
  const filtered = projects.filter((project) => !value.status || project.status === value.status).slice(0, value.limit);
  const collections = await listProjectCollections(filtered.map((project) => project.id), {
    tenantId: caller.context.tenantId,
  });
  const allTasks = filtered.flatMap((project) => collections.tasksByProject.get(project.id) || []);
  const allArtifacts = filtered.flatMap(
    (project) => collections.artifactsByProject.get(project.id) || [],
  );
  const canonicalTasks = await withCanonicalProjectTasks(
    caller.context.tenantId,
    allTasks,
    allArtifacts,
  );
  const canonicalTasksById = new Map(canonicalTasks.map((task) => [task.id, task]));
  const readAt = new Date().toISOString();
  const data = filtered.map((project) => {
    const tasks = (collections.tasksByProject.get(project.id) || []).map(
      (task) => canonicalTasksById.get(task.id) || task,
    );
    return {
      ...project,
      tasks,
      commitmentSummary: buildProjectCommitmentSummary({ tasks, readAt, coverage: "complete" }),
    artifacts: collections.artifactsByProject.get(project.id) || [],
    };
  });
  return completeAppServiceCall(authorized, { projects: data }, { resourceCount: data.length });
}

export async function showProjectService(
  caller: AppServiceCaller,
  input: z.input<typeof projectShowServiceInputSchema>,
) {
  const value = projectShowServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.show"));
  const project = await getOwnedProject(value.projectId, readOwner(caller));
  if (!project) return completeAppServiceCall(authorized, { project: null }, { resourceCount: 0 });
  const [tasks, artifacts] = await Promise.all([
    listProjectTasks(project.id, { tenantId: caller.context.tenantId, limit: value.taskLimit }),
    listProjectArtifacts(project.id, { tenantId: caller.context.tenantId, limit: value.artifactLimit }),
  ]);
  const canonicalTasks = await withCanonicalProjectTasks(caller.context.tenantId, tasks, artifacts);
  return completeAppServiceCall(authorized, {
    project: {
      ...project,
      tasks: canonicalTasks,
      commitmentSummary: buildProjectCommitmentSummary({ tasks: canonicalTasks, readAt: new Date().toISOString(),
        coverage: tasks.length < value.taskLimit ? "complete" : "partial" }),
      artifacts,
    },
  });
}

/** Agent-facing inventory. HTTP/native callers retain the full project service. */
export async function showProjectInventoryService(
  caller: AppServiceCaller,
  input: z.input<typeof projectInventoryServiceInputSchema>,
) {
  const value = projectInventoryServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.show"));
  const page = await listOwnedProjectTasksPage(value.projectId, {
    ...readOwner(caller), limit: value.taskLimit, cursor: value.taskCursor,
  });
  if (!page) return completeAppServiceCall(authorized, { project: null }, { resourceCount: 0 });
  const { project, entries } = page;
  const canonicalTasks = await withCanonicalProjectTasks(caller.context.tenantId, entries.map((entry) => entry.task));
  const tasks = canonicalTasks.map((task) => ({
    id: task.id, title: task.title, status: task.status, priority: task.priority, dueAt: task.dueAt ?? null,
    ...(task.humanOwner ? { humanOwner: task.humanOwner } : {}),
    ...(task.dueDate ? { dueDate: task.dueDate, dueTimeZone: task.dueTimeZone ?? null } : {}),
    dependencyCount: task.dependsOn.length,
    canonicalStatus: task.workItemStatus.status, sourceStatus: task.workItemStatus.sourceStatus,
    readLocator: task.workItemStatus.persistence === "postgres" && task.workItemStatus.workspaceId
      ? { workspaceId: task.workItemStatus.workspaceId, projectId: task.workItemStatus.projectId, workItemId: task.workItemStatus.workItemId }
      : null,
  }));
  const occurredAt = new Date().toISOString();
  const result = (count: number) => {
    const hasMore = page.hasMore || count < entries.length;
    return completeAppServiceCall(authorized, {
      project: {
        id: project.id, tenantId: project.tenantId, actorId: project.actorId,
        title: project.title, objective: value.includeFullObjective ? project.objective : project.objective.slice(0, 400), status: project.status,
        executionStatus: project.executionStatus, targetDate: project.targetDate ?? null, tasks: tasks.slice(0, count),
        commitmentSummary: buildProjectCommitmentSummary({ tasks: canonicalTasks.slice(0, count), readAt: occurredAt,
          coverage: !value.taskCursor && !hasMore ? "complete" : "partial" }),
      },
      taskPage: {
        returnedCount: count, hasMore, nextCursor: hasMore && count ? entries[count - 1].cursor : null,
        requestedCursor: value.taskCursor ?? null,
        startsAtBeginning: !value.taskCursor, consistency: "current_read_not_snapshot",
      },
      omissions: { taskDetails: true, artifacts: true, objective: !value.includeFullObjective && project.objective.length > 400 },
      taskInspection: "Use app.work_items.show with each readLocator before editing and for readback. A null locator means canonical inspection is unavailable.",
      taskMutation: "Use app.work_items.update with project.id and the task's id; readLocator IDs identify canonical inspection, not the legacy mutation target.",
    }, { resourceCount: 1 + count, occurredAt });
  };
  // Measure valid JSON including the actual receipt, reserving 2k for the
  // governed execution envelope. Never slice serialized rows or their IDs.
  const fits = (candidate: ReturnType<typeof result>) => JSON.stringify(redactSensitive({ ...candidate.data, serviceReceipt: candidate.receipt })).length <= 6_000;
  let count = 0;
  let packed = result(count);
  for (; count < tasks.length; count += 1) {
    const candidate = result(count + 1);
    if (!fits(candidate)) break;
    packed = candidate;
  }
  if (!fits(packed) || (tasks.length > 0 && count === 0)) {
    throw new Error("The project inventory metadata exceeds the bounded response; no task IDs were silently omitted.");
  }
  return packed;
}

export async function showProjectTaskService(caller: AppServiceCaller, input: { projectId: string; taskId: string }) {
  const value = z.object({ projectId: z.string().trim().min(1).max(200), taskId: z.string().trim().min(1).max(200) }).strict().parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.show"));
  const task = await getOwnedProjectTask(value.projectId, value.taskId, readOwner(caller));
  const projected = task ? await withCanonicalProjectTasks(caller.context.tenantId, [task]) : [];
  return completeAppServiceCall(authorized, { task: projected[0] ?? null }, { resourceCount: projected.length });
}

export async function createProjectService(
  caller: AppServiceCaller,
  input: z.input<typeof projectCreateServiceInputSchema>,
) {
  const value = redactSensitive(parseProjectMutationInput(projectCreateServiceInputSchema, input, "app.projects.create")) as z.output<typeof projectCreateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.create"));
  const project = await createProject({ ...value, ...exactOwner(caller), mutation: mutationContext(caller) });
  return completeAppServiceCall(authorized, { project: { ...project, tasks: [], artifacts: [] } });
}

export async function updateProjectService(
  caller: AppServiceCaller,
  input: z.input<typeof projectUpdateServiceInputSchema>,
) {
  const value = redactSensitive(parseProjectMutationInput(projectUpdateServiceInputSchema, input, "app.projects.update")) as z.output<typeof projectUpdateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.update"));
  const { projectId, ...change } = value;
  const project = await updateProject(projectId, change, { ...exactOwner(caller), mutation: mutationContext(caller) });
  return completeAppServiceCall(authorized, { project: project || null }, { resourceCount: project ? 1 : 0 });
}

export async function createWorkItemService(
  caller: AppServiceCaller,
  input: z.input<typeof workItemCreateServiceInputSchema>,
) {
  const value = redactSensitive(parseProjectMutationInput(workItemCreateServiceInputSchema, input, "app.work_items.create")) as z.output<typeof workItemCreateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.work_items.create"));
  const { projectId, ...workItem } = value;
  const [created] = await createProjectTasks(projectId, [{ ...workItem, origin: "manual" }], {
    ...exactOwner(caller),
    mutation: mutationContext(caller),
  });
  const [canonical] = created
    ? await withCanonicalProjectTasks(caller.context.tenantId, [created])
    : [];
  return completeAppServiceCall(authorized, { workItem: canonical || null }, { resourceCount: created ? 1 : 0 });
}

export async function updateWorkItemService(
  caller: AppServiceCaller,
  input: z.input<typeof workItemUpdateServiceInputSchema>,
) {
  const value = redactSensitive(parseProjectMutationInput(workItemUpdateServiceInputSchema, input, "app.work_items.update")) as z.output<typeof workItemUpdateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.work_items.update"));
  const { projectId, workItemId, ...change } = value;
  const workItem = await updateProjectTask(projectId, workItemId, change, {
    ...exactOwner(caller),
    mutation: mutationContext(caller),
  });
  const [canonical] = workItem
    ? await withCanonicalProjectTasks(caller.context.tenantId, [workItem])
    : [];
  return completeAppServiceCall(authorized, { workItem: canonical || null }, { resourceCount: workItem ? 1 : 0 });
}

export async function planProjectService(
  caller: AppServiceCaller,
  input: z.input<typeof projectPlanServiceInputSchema>,
) {
  const value = redactSensitive(projectPlanServiceInputSchema.parse(input)) as z.output<typeof projectPlanServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.plan"));
  const plan = await decomposeProject({
    projectId: value.projectId,
    ...exactOwner(caller),
    context: value.context,
    mutation: mutationContext(caller),
  });
  const canonicalPlan = plan ? {
    ...plan,
    tasks: await withCanonicalProjectTasks(caller.context.tenantId, plan.tasks),
  } : null;
  return completeAppServiceCall(authorized, { plan: canonicalPlan }, { resourceCount: plan ? 1 : 0 });
}

export async function controlProjectExecutionService(
  caller: AppServiceCaller,
  input: z.input<typeof projectExecutionServiceInputSchema>,
) {
  const value = projectExecutionServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.execution.control"));
  const scope = { ...exactOwner(caller), executionScope: caller.executionScope!, idempotencyKey: caller.idempotencyKey! };
  const current = await getProject(value.projectId, scope);
  if (!current) return completeAppServiceCall(authorized, { snapshot: null }, { resourceCount: 0 });
  if (current.status !== "active") throw new Error("Only active projects can execute.");

  if (value.action === "configure") {
    await updateProjectExecution(value.projectId, {
      autonomyMode: value.autonomyMode,
      taskBudget: value.taskBudget,
      maxParallelTasks: value.maxParallelTasks,
      requireApproval: value.autonomyMode === "supervised" ? true : value.requireApproval,
    }, { ...exactOwner(caller), mutation: mutationContext(caller) });
    return completeAppServiceCall(authorized, { snapshot: await projectSnapshot(value.projectId, scope) });
  }
  // Pages import this service for project and work item reads. Execution
  // reaches the workflow runtime, so it loads only when a run is controlled.
  const { signalProjectTask, signalProjectWorkflows, syncProjectExecution } = await import(
    "@/lib/projects/execution"
  );
  if (value.action === "pause" || value.action === "resume") {
    const recordStatus = () => updateProjectExecution(value.projectId, {
      executionStatus: value.action === "pause" ? "paused" : "running",
    }, { ...exactOwner(caller), mutation: mutationContext(caller) });
    // A pause is recorded before any run is signaled, so no task is dispatched
    // while its runs pause; a resume is recorded once its runs are queued.
    if (value.action === "pause") await recordStatus();
    const workflows = await signalProjectWorkflows({ projectId: value.projectId, signal: value.action, ...scope });
    if (value.action === "resume") await recordStatus();
    const snapshot = value.action === "resume"
      ? await syncProjectExecution({ projectId: value.projectId, ...scope, drain: true })
      : await projectSnapshot(value.projectId, scope);
    return completeAppServiceCall(authorized, {
      snapshot: await withCanonicalProjectSnapshot(caller.context.tenantId, snapshot),
      workflows,
    });
  }
  if (value.action === "approve" || value.action === "retry") {
    const workflow = await signalProjectTask({ projectId: value.projectId, taskId: value.workItemId, signal: value.action, ...scope });
    if (!workflow) return completeAppServiceCall(authorized, { snapshot: null, workItemFound: false }, { resourceCount: 0 });
    return completeAppServiceCall(authorized, {
      snapshot: await withCanonicalProjectSnapshot(
        caller.context.tenantId,
        await syncProjectExecution({ projectId: value.projectId, ...scope, drain: true }),
      ),
      workItemFound: true,
    });
  }
  if (value.action === "start") {
    const tasks = await listProjectTasks(value.projectId, scope);
    if (!tasks.length) throw new Error("Create or generate a project plan before starting execution.");
    await updateProjectExecution(value.projectId, {
      autonomyMode: value.autonomyMode, executionStatus: "running", taskBudget: value.taskBudget,
      maxParallelTasks: value.maxParallelTasks, requireApproval: value.autonomyMode === "supervised" ? true : value.requireApproval,
    }, { ...exactOwner(caller), mutation: mutationContext(caller) });
  }
  return completeAppServiceCall(authorized, {
    snapshot: await withCanonicalProjectSnapshot(
      caller.context.tenantId,
      await syncProjectExecution({ projectId: value.projectId, ...scope, drain: true }),
    ),
  });
}

export async function recordProjectArtifactFeedbackService(
  caller: AppServiceCaller,
  input: z.input<typeof projectArtifactFeedbackServiceInputSchema>,
) {
  const value = redactSensitive(projectArtifactFeedbackServiceInputSchema.parse(input)) as z.output<typeof projectArtifactFeedbackServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.artifacts.feedback"));
  const artifact = await reflectOnProjectArtifact({ ...value, ...exactOwner(caller), mutation: mutationContext(caller) });
  return completeAppServiceCall(authorized, { artifact: artifact || null }, { resourceCount: artifact ? 1 : 0 });
}

async function projectSnapshot(projectId: string, scope: { tenantId: string; actorId: string }) {
  const [project, tasks, artifacts] = await Promise.all([
    getProject(projectId, scope), listProjectTasks(projectId, scope), listProjectArtifacts(projectId, scope),
  ]);
  return {
    project,
    tasks: await withCanonicalProjectTasks(scope.tenantId, tasks, artifacts),
    artifacts,
    dispatchedTaskIds: [] as string[],
  };
}

async function withCanonicalProjectSnapshot<T extends { tasks: ProjectTask[] }>(
  tenantId: string,
  snapshot: T | undefined,
) {
  if (!snapshot) return undefined;
  return {
    ...snapshot,
    tasks: await withCanonicalProjectTasks(tenantId, snapshot.tasks),
  };
}

async function withCanonicalProjectTasks(
  tenantId: string,
  tasks: readonly ProjectTask[],
  artifacts: readonly ProjectArtifact[] = [],
) {
  const surfaces = await canonicalWorkItemSurfaces(
    tenantId,
    "legacy_project_task",
    tasks.map((task) => {
      const status = canonicalStatusForProjectTask(task);
      return {
        projectId: task.projectId,
        workItemId: task.id,
        kind: "task" as const,
        sourceId: task.id,
        status: status.status,
        sourceStatus: status.sourceStatus,
        updatedAt: task.updatedAt,
        assignedAgents: [{ agentId: task.agentId }],
        artifacts: artifacts
          .filter((artifact) => artifact.taskId === task.id)
          .map((artifact) => ({
            artifactId: artifact.id,
            kind: "project_artifact",
            evidenceRefIds: artifact.evidenceRefs,
          })),
        workflowRunId: task.workflowRunId,
        workflowSourceStatus: task.workflowStatus === "dispatching"
          ? "queued" as const
          : task.workflowStatus,
      };
    }),
  );
  return tasks.map((task) => {
    const workItem = surfaces.get(task.id)!;
    return { ...task, workItemStatus: workItem.status, workItem };
  });
}

function exactOwner(caller: AppServiceCaller) {
  return { tenantId: caller.context.tenantId, actorId: caller.context.actorId };
}

function readOwner(caller: AppServiceCaller) {
  return {
    ...exactOwner(caller),
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(caller.context),
  };
}

function mutationContext(caller: AppServiceCaller) {
  if (!caller.executionScope || !caller.idempotencyKey) {
    throw new Error("Project mutation service requires execution attribution.");
  }
  return {
    executionScope: caller.executionScope,
    idempotencyKey: caller.idempotencyKey,
    principalMode: "user_or_agent" as const,
  };
}
