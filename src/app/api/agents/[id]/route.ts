import { withDatabaseRequestScope } from "@/lib/db/client";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import {
  deleteAgentService,
  previewAgentDeleteService,
  showAgentService,
  updateAgentService,
} from "@/lib/app-services/agents";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { customAgentPatchSchema } from "@/lib/skills/schema";
import {
  AgentSkillAssignmentError,
  CustomAgentReadConflictError,
} from "@/lib/skills/store";
import { MoltbookConnectionError } from "@/lib/moltbook/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request, context: RouteContext<"/api/agents/[id]">) {
  const previewTrash = new URL(request.url).searchParams.get("mode") === "trash-preview";
  let auth;
  try { auth = await authorizeRequest({ request, action: previewTrash ? "manage.workflow" : "read", resourceType: "custom_agent" }); }
  catch (error) { return forbiddenResponse(error); }
  const { id } = await context.params;
  try {
    if (previewTrash) {
      const result = await previewAgentDeleteService(
        createAppServiceCaller({ context: auth }),
        { id },
      );
      return result.data.target
        ? Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders })
        : Response.json({ error: "Custom agent not found." }, { status: 404, headers: privateNoStoreHeaders });
    }
    const result = await showAgentService(createAppServiceCaller({ context: auth }), { id, includeBuiltIns: false });
    return result.data.agent
      ? Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders })
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
    if (error instanceof MoltbookConnectionError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: privateNoStoreHeaders },
      );
    }
    throw error;
  }
}

async function PATCHHandler(request: Request, context: RouteContext<"/api/agents/[id]">) {
  let auth;
  try { auth = await authorizeRequest({ request, action: "manage.workflow", resourceType: "custom_agent", nativeMutationCapability: "agents.update", metadata: { operation: "update" } }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request, 28_000); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = customAgentPatchSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid agent update", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await context.params;
  try {
    const result = await updateAgentService(
      createRequestMutationAppServiceCaller(request, auth, { purpose: "agent.update", causationId: id }),
      { id, change: parsed.data },
    );
    return result.data.agent ? Response.json({ ...result.data, serviceReceipt: result.receipt }) : Response.json({ error: "Custom agent not found." }, { status: 404 });
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
  let body: unknown;
  try { body = await parseJsonBody(request, 16_000); } catch (error) { return jsonBodyErrorResponse(error); }
  const { id } = await context.params;
  try {
    const result = await deleteAgentService(
      createRequestMutationAppServiceCaller(request, auth, {
        purpose: "agent.move_to_trash",
        causationId: id,
      }),
      { id, ...(body && typeof body === "object" ? body : {}) } as never,
    );
    return Response.json({ ...result.data, serviceReceipt: result.receipt });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Agent could not be moved to trash." },
      { status: error instanceof Error && /not found/i.test(error.message) ? 404 : 409 },
    );
  }
}
