import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { agentMemoryGrantDraftV1Schema } from "@/lib/memory/agent-grant-editor";
import {
  AgentMemoryGrantConflictError,
  AgentMemoryGrantUnavailableError,
  createAgentMemoryGrant,
  listAgentMemoryGrants,
} from "@/lib/memory/agent-grant-store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "read",
      resourceType: "custom_agent",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const { id } = await context.params;
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(auth);
  if (!actorBinding) return canonicalActorUnavailableResponse();
  try {
    const grants = await listAgentMemoryGrants(id, {
      tenantId: auth.tenantId,
      actorId: auth.actorId,
      canonicalActorId: actorBinding.canonicalActorId,
    });
    return Response.json({ grants }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return grantErrorResponse(error);
  }
}

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "custom_agent",
      metadata: { operation: "create_memory_grant" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  let body: unknown;
  try {
    body = await parseJsonBody(request, 16_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = agentMemoryGrantDraftV1Schema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid Agent memory grant.",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  const { id } = await context.params;
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(auth);
  if (!actorBinding) return canonicalActorUnavailableResponse();
  try {
    const grant = await createAgentMemoryGrant(id, parsed.data, {
      tenantId: auth.tenantId,
      actorId: auth.actorId,
      canonicalActorId: actorBinding.canonicalActorId,
    });
    return Response.json({ grant }, {
      status: 201,
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    return grantErrorResponse(error);
  }
}

function canonicalActorUnavailableResponse() {
  return Response.json({
    error: "Canonical Agent grant ownership could not be verified.",
  }, { status: 409, headers: privateNoStoreHeaders });
}

function grantErrorResponse(error: unknown) {
  if (error instanceof AgentMemoryGrantConflictError) {
    return Response.json({ error: error.message }, {
      status: 409,
      headers: privateNoStoreHeaders,
    });
  }
  if (error instanceof AgentMemoryGrantUnavailableError) {
    return Response.json({ error: error.message }, {
      status: 503,
      headers: privateNoStoreHeaders,
    });
  }
  throw error;
}
