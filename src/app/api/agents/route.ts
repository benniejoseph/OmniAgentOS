import { withDatabaseRequestScope } from "@/lib/db/client";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { createAgentService, listAgentsService } from "@/lib/app-services/agents";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { customAgentInputSchema } from "@/lib/skills/schema";
import {
  AgentSkillAssignmentError,
  CustomAgentReadConflictError,
} from "@/lib/skills/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "custom_agent" }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    const result = await listAgentsService(createAppServiceCaller({ context }), {
      ownerScope: new URL(request.url).searchParams.get("ownerScope") === "readable" ? "readable" : "exact",
    });
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: privateNoStoreHeaders },
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

async function POSTHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "custom_agent", metadata: { operation: "create" } }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request, 28_000); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = customAgentInputSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid agent", details: parsed.error.flatten() }, { status: 400 });
  try {
    const result = await createAgentService(
      createRequestMutationAppServiceCaller(request, context, { purpose: "agent.create" }),
      parsed.data,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: 201 });
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
      { error: duplicate ? "An agent with this name already exists." : "Agent creation failed." },
      {
        status: duplicate ? 409 : 500,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
}
