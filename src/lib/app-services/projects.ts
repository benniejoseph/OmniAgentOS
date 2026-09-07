import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  createProject,
  createProjectTasks,
  getOwnedProject,
  listProjectArtifacts,
  listProjectCollections,
  listProjects,
  listProjectTasks,
  updateProject,
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
