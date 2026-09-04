import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { customAgentPatchSchema } from "@/lib/skills/schema";
import {
  AgentSkillAssignmentError,
  CustomAgentReadConflictError,
  deleteCustomAgent,
  getCustomAgentForRequest,
  updateCustomAgent,
} from "@/lib/skills/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request, context: RouteContext<"/api/agents/[id]">) {
  let auth;
  try { auth = await authorizeRequest({ request, action: "read", resourceType: "custom_agent" }); }
  catch (error) { return forbiddenResponse(error); }
  const { id } = await context.params;
  try {
    const agent = await getCustomAgentForRequest(id, {
      tenantId: auth.tenantId,
      actorId: auth.actorId,
      requestActorBinding: canonicalRequestActorBindingFromSecurityContext(auth),
    });
    return agent
      ? Response.json({ agent }, { headers: privateNoStoreHeaders })
      : Response.json(
          { error: "Agent not found." },
          { status: 404, headers: privateNoStoreHeaders },
        );
  } catch (error) {
    if (error instanceof CustomAgentReadConflictError) {
      return Response.json(
        { error: "Custom Agent ownership could not be verified." },
        { status: 409, headers: privateNoStoreHeaders },
      );
    }
    throw error;
  }
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
  try {
    const agent = await updateCustomAgent(id, parsed.data, { tenantId: auth.tenantId, actorId: auth.actorId });
    return agent ? Response.json({ agent }) : Response.json({ error: "Custom agent not found." }, { status: 404 });
  } catch (error) {
    if (error instanceof AgentSkillAssignmentError) {
      return Response.json(
        { error: "One or more selected skills are unavailable for this agent." },
        { status: 409, headers: { "cache-control": "private, no-store" } },
      );
    }
    const duplicate = error instanceof Error &&
      /unique|duplicate|already exists/i.test(error.message);
    return Response.json(
      { error: duplicate ? "An agent with this name already exists." : "Agent update failed." },
      {
        status: duplicate ? 409 : 500,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
}

async function DELETEHandler(request: Request, context: RouteContext<"/api/agents/[id]">) {
  let auth;
  try { auth = await authorizeRequest({ request, action: "manage.workflow", resourceType: "custom_agent", metadata: { operation: "delete" } }); }
  catch (error) { return forbiddenResponse(error); }
  const { id } = await context.params;
  const deleted = await deleteCustomAgent(id, { tenantId: auth.tenantId, actorId: auth.actorId });
  return deleted ? Response.json({ deleted: true }) : Response.json({ error: "Custom agent not found." }, { status: 404 });
}
