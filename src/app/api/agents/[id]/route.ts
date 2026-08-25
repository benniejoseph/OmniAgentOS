import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { customAgentPatchSchema } from "@/lib/skills/schema";
import { deleteCustomAgent, getCustomAgent, updateCustomAgent } from "@/lib/skills/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

async function GETHandler(request: Request, context: RouteContext<"/api/agents/[id]">) {
  let auth;
  try { auth = await authorizeRequest({ request, action: "read", resourceType: "custom_agent" }); }
  catch (error) { return forbiddenResponse(error); }
  const { id } = await context.params;
  const agent = await getCustomAgent(id, { tenantId: auth.tenantId, actorId: auth.actorId });
  return agent ? Response.json({ agent }) : Response.json({ error: "Agent not found." }, { status: 404 });
}

async function PATCHHandler(request: Request, context: RouteContext<"/api/agents/[id]">) {
  let auth;
  try { auth = await authorizeRequest({ request, action: "manage.workflow", resourceType: "custom_agent", metadata: { operation: "update" } }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request, 28_000); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = customAgentPatchSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid agent update", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await context.params;
  const agent = await updateCustomAgent(id, parsed.data, { tenantId: auth.tenantId, actorId: auth.actorId });
  return agent ? Response.json({ agent }) : Response.json({ error: "Custom agent not found." }, { status: 404 });
}

async function DELETEHandler(request: Request, context: RouteContext<"/api/agents/[id]">) {
  let auth;
  try { auth = await authorizeRequest({ request, action: "manage.workflow", resourceType: "custom_agent", metadata: { operation: "delete" } }); }
  catch (error) { return forbiddenResponse(error); }
  const { id } = await context.params;
  const deleted = await deleteCustomAgent(id, { tenantId: auth.tenantId, actorId: auth.actorId });
  return deleted ? Response.json({ deleted: true }) : Response.json({ error: "Custom agent not found." }, { status: 404 });
}
