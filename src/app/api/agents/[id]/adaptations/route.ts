import { z } from "zod";

import {
  listAgentAdaptationsService,
  manageAgentAdaptationService,
  refreshAgentAdaptationsService,
} from "@/lib/app-services/agent-governance";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import {
  AgentAdaptationConflictError,
  AgentAdaptationUnavailableError,
} from "@/lib/agents/adaptation-store";
import {
  AgentIdentityResolutionError,
} from "@/lib/agents/identity-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
const adaptationIdSchema = z.string().regex(/^agent-adaptation:[a-f0-9]{64}$/);
const adaptationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh") }).strict(),
  z.object({ action: z.literal("evaluate"), adaptationId: adaptationIdSchema })
    .strict(),
  z.object({ action: z.literal("activate"), adaptationId: adaptationIdSchema })
    .strict(),
  z.object({ action: z.literal("rollback"), adaptationId: adaptationIdSchema })
    .strict(),
]);

async function GETHandler(
  request: Request,
  context: RouteContext<"/api/agents/[id]/adaptations">,
) {
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "read",
      resourceType: "agent_adaptation",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const { id } = await context.params;
  const owner = adaptationOwner(auth);
  if (!owner) return canonicalActorUnavailableResponse();
  try {
    const result = await listAgentAdaptationsService(createAppServiceCaller({ context: auth }), { agentId: id });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return adaptationErrorResponse(error);
  }
}

async function POSTHandler(
  request: Request,
  context: RouteContext<"/api/agents/[id]/adaptations">,
) {
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "agent_adaptation",
      nativeMutationCapability: "agents.adaptations.manage",
      metadata: { operation: "manage_adaptation" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  let body: unknown;
  try {
    body = await parseJsonBody(request, 2_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = adaptationActionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid Agent adaptation action.",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  const { id } = await context.params;
  const owner = adaptationOwner(auth);
  if (!owner) return canonicalActorUnavailableResponse();
  try {
    const caller = createRequestMutationAppServiceCaller(request, auth, { purpose: `agent.adaptation.${parsed.data.action}`, causationId: id });
    const result = parsed.data.action === "refresh"
      ? await refreshAgentAdaptationsService(caller, { agentId: id })
      : await manageAgentAdaptationService(caller, { agentId: id, action: parsed.data.action, adaptationId: parsed.data.adaptationId });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return adaptationErrorResponse(error);
  }
}

function adaptationOwner(auth: Awaited<ReturnType<typeof authorizeRequest>>) {
  const binding = canonicalRequestActorBindingFromSecurityContext(auth);
  return binding ? {
    tenantId: auth.tenantId,
    actorId: auth.actorId,
    canonicalActorId: binding.canonicalActorId,
  } : undefined;
}

function canonicalActorUnavailableResponse() {
  return Response.json({
    error: "Canonical Agent adaptation ownership could not be verified.",
  }, { status: 409, headers: privateNoStoreHeaders });
}

function adaptationErrorResponse(error: unknown) {
  if (
    error instanceof AgentAdaptationConflictError ||
    error instanceof AgentIdentityResolutionError
  ) {
    return Response.json({ error: error.message }, {
      status: 409,
      headers: privateNoStoreHeaders,
    });
  }
  if (error instanceof AgentAdaptationUnavailableError) {
    return Response.json({ error: error.message }, {
      status: 503,
      headers: privateNoStoreHeaders,
    });
  }
  throw error;
}
