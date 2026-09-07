import { withDatabaseRequestScope } from "@/lib/db/client";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { showSkillService, updateSkillService } from "@/lib/app-services/agents";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { skillPatchSchema } from "@/lib/skills/schema";
import { deleteAgentSkill } from "@/lib/skills/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

async function GETHandler(request: Request, context: RouteContext<"/api/skills/[id]">) {
  let auth;
  try { auth = await authorizeRequest({ request, action: "read", resourceType: "agent_skill" }); }
  catch (error) { return forbiddenResponse(error); }
  const { id } = await context.params;
  const result = await showSkillService(createAppServiceCaller({ context: auth }), { id });
  const headers = { "cache-control": "private, no-store" };
  return result.data.skill
    ? Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers })
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
  const result = await updateSkillService(
    createRequestMutationAppServiceCaller(request, auth, { purpose: "skill.update", causationId: id }),
    { id, change: parsed.data },
  );
  return result.data.skill ? Response.json({ ...result.data, serviceReceipt: result.receipt }) : Response.json({ error: "Custom skill not found." }, { status: 404 });
}

async function DELETEHandler(request: Request, context: RouteContext<"/api/skills/[id]">) {
  let auth;
  try { auth = await authorizeRequest({ request, action: "manage.workflow", resourceType: "agent_skill", metadata: { operation: "delete" } }); }
  catch (error) { return forbiddenResponse(error); }
  const { id } = await context.params;
  const deleted = await deleteAgentSkill(id, { tenantId: auth.tenantId, actorId: auth.actorId });
  return deleted ? Response.json({ deleted: true }) : Response.json({ error: "Custom skill not found." }, { status: 404 });
}
