import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { decomposeProject, ProjectPlanningError } from "@/lib/projects/planner";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = withDatabaseRequestScope(POSTHandler);
const schema = z.object({ context: z.string().trim().max(4_000).optional() }).strict();

async function POSTHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid planning request", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try { context = await authorizeRequest({ request, action: "run.agent", resourceType: "project_plan", resourceId: id }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    const plan = await decomposeProject({ projectId: id, tenantId: context.tenantId, actorId: context.actorId, context: parsed.data.context });
    return plan ? Response.json({ plan }) : Response.json({ error: "Project not found." }, { status: 404 });
  } catch (error) {
    return error instanceof ProjectPlanningError
      ? Response.json({ error: error.message }, { status: 409 })
      : Response.json({ error: error instanceof Error ? error.message : "Project planning failed." }, { status: 500 });
  }
}
