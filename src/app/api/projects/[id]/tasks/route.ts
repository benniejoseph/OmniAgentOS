import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { createProjectTasks, getProject } from "@/lib/projects/store";
import { projectMutationFromRequest } from "@/lib/projects/request-mutation";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);
const agentIds = ["atlas", "scout", "forge", "sentinel", "mnemosyne"] as const;
const schema = z.object({ title: z.string().trim().min(1).max(240), detail: z.string().trim().max(1_000).optional(), priority: z.enum(["low", "medium", "high"]).optional(), agentId: z.enum(agentIds).optional(), dueAt: z.string().datetime().optional() }).strict();

async function POSTHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid project task", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try { context = await authorizeRequest({ request, action: "run.agent", resourceType: "project_task" }); }
  catch (error) { return forbiddenResponse(error); }
  const project = await getProject(id, { tenantId: context.tenantId, actorId: context.actorId });
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  if (project.status !== "active") return Response.json({ error: "Tasks can only be added to an active project." }, { status: 409 });
  try {
    const [task] = await createProjectTasks(
      id,
      [{ ...parsed.data, origin: "manual" }],
      {
        tenantId: context.tenantId,
        actorId: context.actorId,
        mutation: projectMutationFromRequest(request, context, {
          projectId: id,
          purpose: "project.task.create",
        }),
      },
    );
    return task
      ? Response.json({ task }, { status: 201 })
      : Response.json(
          { error: "A task with this title already exists." },
          { status: 409 },
        );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project task creation failed.";
    return Response.json(
      { error: message },
      { status: message.startsWith("Idempotency-Key") ? 400 : 409 },
    );
  }
}
