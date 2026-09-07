import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  signalProjectTask,
  signalProjectWorkflows,
  syncProjectExecution,
} from "@/lib/projects/execution";
import { decomposeProject } from "@/lib/projects/planner";
import { reflectOnProjectArtifact } from "@/lib/projects/reflection";
import {
  createProject,
  createProjectTasks,
  getProject,
  getOwnedProject,
  listProjectArtifacts,
  listProjectCollections,
  listProjects,
  listProjectTasks,
  updateProject,
  updateProjectExecution,
  updateProjectTask,
} from "@/lib/projects/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";

const projectStatusSchema = z.enum(["draft", "active", "completed", "archived"]);
const projectTaskStatusSchema = z.enum(["open", "doing", "done"]);
const projectTaskPrioritySchema = z.enum(["low", "medium", "high"]);
const projectAgentSchema = z.enum(["atlas", "scout", "forge", "sentinel", "mnemosyne"]);

export const projectListServiceInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  status: projectStatusSchema.optional(),
}).strict();

export const projectShowServiceInputSchema = z.object({
  projectId: z.string().uuid(),
  taskLimit: z.number().int().min(1).max(200).default(100),
  artifactLimit: z.number().int().min(1).max(200).default(100),
}).strict();

export const projectCreateServiceInputSchema = z.object({
  title: z.string().trim().min(1).max(180),
  objective: z.string().trim().min(1).max(2_000),
  status: z.enum(["draft", "active"]).default("active"),
  targetDate: z.string().datetime({ offset: true }).optional(),
}).strict();

export const projectUpdateServiceInputSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(180).optional(),
  objective: z.string().trim().min(1).max(2_000).optional(),
  status: projectStatusSchema.optional(),
  targetDate: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().refine(({ projectId: _projectId, ...change }) => Object.keys(change).length > 0, {
  message: "A project change is required.",
});

export const workItemCreateServiceInputSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(240),
  detail: z.string().trim().max(1_000).optional(),
  priority: projectTaskPrioritySchema.default("medium"),
  agentId: projectAgentSchema.default("atlas"),
  dueAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export const workItemUpdateServiceInputSchema = z.object({
  projectId: z.string().uuid(),
  workItemId: z.string().uuid(),
  title: z.string().trim().min(1).max(240).optional(),
  detail: z.string().trim().max(1_000).optional(),
  status: projectTaskStatusSchema.optional(),
  priority: projectTaskPrioritySchema.optional(),
  agentId: projectAgentSchema.optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().refine(({ projectId: _projectId, workItemId: _workItemId, ...change }) => Object.keys(change).length > 0, {
  message: "A work-item change is required.",
});

export const projectPlanServiceInputSchema = z.object({
  projectId: z.string().uuid(),
  context: z.string().trim().max(4_000).optional(),
}).strict();

const projectExecutionConfigurationFields = {
  autonomyMode: z.enum(["manual", "supervised", "autonomous"]),
  taskBudget: z.number().int().min(1).max(50),
  maxParallelTasks: z.number().int().min(1).max(3),
  requireApproval: z.boolean(),
};
export const projectExecutionServiceInputSchema = z.discriminatedUnion("action", [
  z.object({ projectId: z.string().uuid(), action: z.literal("configure"), ...projectExecutionConfigurationFields }).strict(),
  z.object({ projectId: z.string().uuid(), action: z.literal("start"), ...projectExecutionConfigurationFields, autonomyMode: z.enum(["supervised", "autonomous"]) }).strict(),
  z.object({ projectId: z.string().uuid(), action: z.enum(["pause", "resume", "sync"]) }).strict(),
  z.object({ projectId: z.string().uuid(), action: z.enum(["approve", "retry"]), workItemId: z.string().uuid() }).strict(),
]);

export const projectArtifactFeedbackServiceInputSchema = z.object({
  projectId: z.string().uuid(), artifactId: z.string().uuid(),
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
  const data = filtered.map((project) => ({
    ...project,
    tasks: collections.tasksByProject.get(project.id) || [],
    artifacts: collections.artifactsByProject.get(project.id) || [],
  }));
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
  return completeAppServiceCall(authorized, { project: { ...project, tasks, artifacts } });
}

export async function createProjectService(
  caller: AppServiceCaller,
  input: z.input<typeof projectCreateServiceInputSchema>,
) {
  const value = redactSensitive(projectCreateServiceInputSchema.parse(input)) as z.output<typeof projectCreateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.create"));
  const project = await createProject({ ...value, ...exactOwner(caller), mutation: mutationContext(caller) });
  return completeAppServiceCall(authorized, { project: { ...project, tasks: [], artifacts: [] } });
}

export async function updateProjectService(
  caller: AppServiceCaller,
  input: z.input<typeof projectUpdateServiceInputSchema>,
) {
  const value = redactSensitive(projectUpdateServiceInputSchema.parse(input)) as z.output<typeof projectUpdateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.projects.update"));
  const { projectId, ...change } = value;
  const project = await updateProject(projectId, change, { ...exactOwner(caller), mutation: mutationContext(caller) });
  return completeAppServiceCall(authorized, { project: project || null }, { resourceCount: project ? 1 : 0 });
}

export async function createWorkItemService(
  caller: AppServiceCaller,
  input: z.input<typeof workItemCreateServiceInputSchema>,
) {
  const value = redactSensitive(workItemCreateServiceInputSchema.parse(input)) as z.output<typeof workItemCreateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.work_items.create"));
  const { projectId, ...workItem } = value;
  const [created] = await createProjectTasks(projectId, [{ ...workItem, origin: "manual" }], {
    ...exactOwner(caller),
    mutation: mutationContext(caller),
  });
  return completeAppServiceCall(authorized, { workItem: created || null }, { resourceCount: created ? 1 : 0 });
}

export async function updateWorkItemService(
  caller: AppServiceCaller,
  input: z.input<typeof workItemUpdateServiceInputSchema>,
) {
  const value = redactSensitive(workItemUpdateServiceInputSchema.parse(input)) as z.output<typeof workItemUpdateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.work_items.update"));
  const { projectId, workItemId, ...change } = value;
  const workItem = await updateProjectTask(projectId, workItemId, change, {
    ...exactOwner(caller),
    mutation: mutationContext(caller),
  });
  return completeAppServiceCall(authorized, { workItem: workItem || null }, { resourceCount: workItem ? 1 : 0 });
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
  return completeAppServiceCall(authorized, { plan: plan || null }, { resourceCount: plan ? 1 : 0 });
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
  if (value.action === "pause" || value.action === "resume") {
    await signalProjectWorkflows({ projectId: value.projectId, signal: value.action, ...scope });
    await updateProjectExecution(value.projectId, { executionStatus: value.action === "pause" ? "paused" : "running" }, {
      ...exactOwner(caller), mutation: mutationContext(caller),
    });
    const snapshot = value.action === "resume"
      ? await syncProjectExecution({ projectId: value.projectId, ...scope, drain: true })
      : await projectSnapshot(value.projectId, scope);
    return completeAppServiceCall(authorized, { snapshot });
  }
  if (value.action === "approve" || value.action === "retry") {
    const workflow = await signalProjectTask({ projectId: value.projectId, taskId: value.workItemId, signal: value.action, ...scope });
    if (!workflow) return completeAppServiceCall(authorized, { snapshot: null, workItemFound: false }, { resourceCount: 0 });
    return completeAppServiceCall(authorized, { snapshot: await syncProjectExecution({ projectId: value.projectId, ...scope, drain: true }), workItemFound: true });
  }
  if (value.action === "start") {
    const tasks = await listProjectTasks(value.projectId, scope);
    if (!tasks.length) throw new Error("Create or generate a project plan before starting execution.");
    await updateProjectExecution(value.projectId, {
      autonomyMode: value.autonomyMode, executionStatus: "running", taskBudget: value.taskBudget,
      maxParallelTasks: value.maxParallelTasks, requireApproval: value.autonomyMode === "supervised" ? true : value.requireApproval,
    }, { ...exactOwner(caller), mutation: mutationContext(caller) });
  }
  return completeAppServiceCall(authorized, { snapshot: await syncProjectExecution({ projectId: value.projectId, ...scope, drain: true }) });
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
  return { project, tasks, artifacts, dispatchedTaskIds: [] as string[] };
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
  return { executionScope: caller.executionScope, idempotencyKey: caller.idempotencyKey };
}
