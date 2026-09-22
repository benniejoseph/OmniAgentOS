import {
  previewAgentGrantRevokeService,
  revokeAgentGrantService,
} from "@/lib/app-services/agent-governance";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  AgentMemoryGrantConflictError,
  AgentMemoryGrantUnavailableError,
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
    const caller = createRequestMutationAppServiceCaller(request, auth, {
      purpose: "agent.memory_grant.revoke",
      causationId: grantId,
    });
    const preview = await previewAgentGrantRevokeService(caller, {
      agentId: id,
      grantId,
    });
    if (!preview.data.target) {
      return Response.json({ error: "Agent memory grant not found." }, {
        status: 404,
        headers: privateNoStoreHeaders,
      });
    }
    const result = await revokeAgentGrantService(caller, {
      agentId: id,
      grantId,
      expectedTargetSha256: preview.data.targetSha256,
    });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
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
