import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  getProject,
  listProjectArtifacts,
  listProjectTasks,
  ProjectTransitionError,
  updateProject,
} from "@/lib/projects/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const updateSchema = z.object({
  title: z.string().trim().min(1).max(180).optional(),
  objective: z.string().trim().min(1).max(2_000).optional(),
  status: z.enum(["draft", "active", "completed", "archived"]).optional(),
  targetDate: z.string().datetime().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: "A change is required." });

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "project",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const scope = { tenantId: context.tenantId, actorId: context.actorId };
  const project = await getProject(id, scope);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  const [tasks, artifacts] = await Promise.all([
    listProjectTasks(id, { tenantId: context.tenantId, limit: 30 }),
    listProjectArtifacts(id, { tenantId: context.tenantId, limit: 100 }),
  ]);
  return Response.json({ project: { ...project, tasks, artifacts } }, {
    headers: { "cache-control": "private, no-store" },
  });
}

async function PATCHHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid project update", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try { context = await authorizeRequest({ request, action: "run.agent", resourceType: "project", resourceId: id }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    const project = await updateProject(id, parsed.data, { tenantId: context.tenantId, actorId: context.actorId });
    return project ? Response.json({ project }) : Response.json({ error: "Project not found." }, { status: 404 });
  } catch (error) {
    return error instanceof ProjectTransitionError
      ? Response.json({ error: error.message }, { status: 409 })
      : Response.json({ error: error instanceof Error ? error.message : "Project update failed." }, { status: 500 });
  }
}
