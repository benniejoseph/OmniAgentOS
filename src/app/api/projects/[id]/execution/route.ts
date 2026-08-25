import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  signalProjectTask,
  signalProjectWorkflows,
  syncProjectExecution,
} from "@/lib/projects/execution";
import {
  getProject,
  listProjectArtifacts,
  listProjectTasks,
  updateProjectExecution,
} from "@/lib/projects/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("configure"),
    autonomyMode: z.enum(["manual", "supervised", "autonomous"]),
    taskBudget: z.number().int().min(1).max(50),
    maxParallelTasks: z.number().int().min(1).max(3),
    requireApproval: z.boolean(),
  }).strict(),
  z.object({
    action: z.literal("start"),
    autonomyMode: z.enum(["supervised", "autonomous"]),
    taskBudget: z.number().int().min(1).max(50),
    maxParallelTasks: z.number().int().min(1).max(3),
    requireApproval: z.boolean(),
  }).strict(),
  z.object({ action: z.enum(["pause", "resume", "sync"]) }).strict(),
  z.object({ action: z.enum(["approve", "retry"]), taskId: z.string().uuid() }).strict(),
]);

async function POSTHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid project execution command", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "project_execution", resourceId: id, metadata: { action: parsed.data.action } });
  } catch (error) { return forbiddenResponse(error); }
  const scope = { tenantId: context.tenantId, actorId: context.actorId };
  const current = await getProject(id, scope);
  if (!current) return Response.json({ error: "Project not found." }, { status: 404 });
  if (current.status !== "active") return Response.json({ error: "Only active projects can execute." }, { status: 409 });

  try {
    if (parsed.data.action === "configure") {
      const project = await updateProjectExecution(id, {
        autonomyMode: parsed.data.autonomyMode,
        taskBudget: parsed.data.taskBudget,
        maxParallelTasks: parsed.data.maxParallelTasks,
        requireApproval: parsed.data.autonomyMode === "supervised" ? true : parsed.data.requireApproval,
      }, scope);
      return Response.json({ project, tasks: await listProjectTasks(id, scope), artifacts: await listProjectArtifacts(id, scope) });
    }
    if (parsed.data.action === "pause") {
      await updateProjectExecution(id, { executionStatus: "paused" }, scope);
      await signalProjectWorkflows({ projectId: id, tenantId: context.tenantId, signal: "pause" });
      return Response.json(await currentSnapshot(id, scope));
    }
    if (parsed.data.action === "resume") {
      await signalProjectWorkflows({ projectId: id, tenantId: context.tenantId, signal: "resume" });
      await updateProjectExecution(id, { executionStatus: "running" }, scope);
      return Response.json(await syncProjectExecution({ projectId: id, ...scope, drain: true }));
    }
    if (parsed.data.action === "approve" || parsed.data.action === "retry") {
      const workflow = await signalProjectTask({ projectId: id, taskId: parsed.data.taskId, signal: parsed.data.action, ...scope });
      if (!workflow) return Response.json({ error: "Project task workflow not found." }, { status: 404 });
      return Response.json(await syncProjectExecution({ projectId: id, ...scope, drain: true }));
    }
    if (parsed.data.action === "start") {
      const tasks = await listProjectTasks(id, scope);
      if (!tasks.length) return Response.json({ error: "Create or generate a project plan before starting execution." }, { status: 409 });
      await updateProjectExecution(id, {
        autonomyMode: parsed.data.autonomyMode,
        executionStatus: "running",
        taskBudget: parsed.data.taskBudget,
        maxParallelTasks: parsed.data.maxParallelTasks,
        requireApproval: parsed.data.autonomyMode === "supervised" ? true : parsed.data.requireApproval,
      }, scope);
      return Response.json(await syncProjectExecution({ projectId: id, ...scope, drain: true }));
    }
    return Response.json(await syncProjectExecution({ projectId: id, ...scope, drain: true }));
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Project execution command failed.",
    }, { status: 409 });
  }
}

async function currentSnapshot(projectId: string, scope: { tenantId: string; actorId: string }) {
  return {
    project: await getProject(projectId, scope),
    tasks: await listProjectTasks(projectId, scope),
    artifacts: await listProjectArtifacts(projectId, scope),
    dispatchedTaskIds: [],
  };
}
