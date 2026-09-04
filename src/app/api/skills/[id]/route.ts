import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { skillPatchSchema } from "@/lib/skills/schema";
import { deleteAgentSkill, getAgentSkillForRequest, updateAgentSkill } from "@/lib/skills/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

async function GETHandler(request: Request, context: RouteContext<"/api/skills/[id]">) {
  let auth;
  try { auth = await authorizeRequest({ request, action: "read", resourceType: "agent_skill" }); }
  catch (error) { return forbiddenResponse(error); }
  const { id } = await context.params;
  const skill = await getAgentSkillForRequest(id, {
    tenantId: auth.tenantId,
    actorId: auth.actorId,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(auth),
  });
  const headers = { "cache-control": "private, no-store" };
  return skill
    ? Response.json({ skill }, { headers })
    : Response.json({ error: "Skill not found." }, { status: 404, headers });
}

async function PATCHHandler(request: Request, context: RouteContext<"/api/skills/[id]">) {
  let auth;
  try { auth = await authorizeRequest({ request, action: "manage.workflow", resourceType: "agent_skill", metadata: { operation: "update" } }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request, 24_000); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = skillPatchSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid skill update", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await context.params;
  const skill = await updateAgentSkill(id, parsed.data, { tenantId: auth.tenantId, actorId: auth.actorId });
  return skill ? Response.json({ skill }) : Response.json({ error: "Custom skill not found." }, { status: 404 });
}

async function DELETEHandler(request: Request, context: RouteContext<"/api/skills/[id]">) {
  let auth;
  try { auth = await authorizeRequest({ request, action: "manage.workflow", resourceType: "agent_skill", metadata: { operation: "delete" } }); }
  catch (error) { return forbiddenResponse(error); }
  const { id } = await context.params;
  const deleted = await deleteAgentSkill(id, { tenantId: auth.tenantId, actorId: auth.actorId });
  return deleted ? Response.json({ deleted: true }) : Response.json({ error: "Custom skill not found." }, { status: 404 });
}
