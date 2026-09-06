import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  AgentMemoryGrantConflictError,
  AgentMemoryGrantUnavailableError,
  revokeAgentMemoryGrant,
} from "@/lib/memory/agent-grant-store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function DELETEHandler(
  request: Request,
  context: { params: Promise<{ id: string; grantId: string }> },
) {
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "custom_agent",
      metadata: { operation: "revoke_memory_grant" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const { id, grantId } = await context.params;
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(auth);
  if (!actorBinding) {
    return Response.json({
      error: "Canonical Agent grant ownership could not be verified.",
    }, { status: 409, headers: privateNoStoreHeaders });
  }
  try {
    await revokeAgentMemoryGrant(id, grantId, {
      tenantId: auth.tenantId,
      actorId: auth.actorId,
      canonicalActorId: actorBinding.canonicalActorId,
    });
    return Response.json({ revoked: true }, {
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
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
}
