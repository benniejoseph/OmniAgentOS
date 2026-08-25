import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { arsenalAgents } from "@/lib/agents/arsenal";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { customAgentInputSchema } from "@/lib/skills/schema";
import { createCustomAgent, listCustomAgents } from "@/lib/skills/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "custom_agent" }); }
  catch (error) { return forbiddenResponse(error); }
  return Response.json({ builtIns: arsenalAgents, agents: await listCustomAgents({ tenantId: context.tenantId, actorId: context.actorId }) }, { headers: { "cache-control": "private, no-store" } });
}

async function POSTHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "custom_agent", metadata: { operation: "create" } }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request, 28_000); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = customAgentInputSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid agent", details: parsed.error.flatten() }, { status: 400 });
  try {
    const agent = await createCustomAgent(parsed.data, { tenantId: context.tenantId, actorId: context.actorId });
    return Response.json({ agent }, { status: 201 });
  } catch (error) {
    const duplicate = error instanceof Error && /unique|duplicate/i.test(error.message);
    return Response.json({ error: duplicate ? "An agent with this name already exists." : "Agent creation failed." }, { status: duplicate ? 409 : 500 });
  }
}
