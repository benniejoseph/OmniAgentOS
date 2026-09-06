import { z } from "zod";

import {
  AgentReleaseConflictError,
  AgentReleaseUnavailableError,
  evaluateAgentRelease,
  getAgentRelease,
  promoteAgentRelease,
  retireAgentRelease,
  rollbackAgentRelease,
} from "@/lib/agents/release-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
const evaluationIdSchema = z.string().trim().min(1).max(240).regex(
  /^agent-release-evaluation:[a-f0-9]{64}$/,
);
const releaseActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("evaluate"),
    definitionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({
    action: z.literal("promote"),
    evaluationId: evaluationIdSchema,
  }).strict(),
  z.object({
    action: z.literal("rollback"),
    evaluationId: evaluationIdSchema,
  }).strict(),
  z.object({
    action: z.literal("retire"),
    confirmation: z.literal("RETIRE AGENT"),
  }).strict(),
]);

async function GETHandler(
  request: Request,
  context: RouteContext<"/api/agents/[id]/release">,
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
  const owner = releaseOwner(auth);
  if (!owner) return canonicalActorUnavailableResponse();
  try {
    return Response.json({ release: await getAgentRelease(id, owner) }, {
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    return releaseErrorResponse(error);
  }
}

async function POSTHandler(
  request: Request,
  context: RouteContext<"/api/agents/[id]/release">,
) {
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "custom_agent",
      metadata: { operation: "manage_release" },
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
  const parsed = releaseActionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid Agent release action.",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  const { id } = await context.params;
  const owner = releaseOwner(auth);
  if (!owner) return canonicalActorUnavailableResponse();
  try {
    const release = parsed.data.action === "evaluate"
      ? await evaluateAgentRelease(id, parsed.data.definitionVersion, owner)
      : parsed.data.action === "promote"
        ? await promoteAgentRelease(id, parsed.data.evaluationId, owner)
        : parsed.data.action === "rollback"
          ? await rollbackAgentRelease(id, parsed.data.evaluationId, owner)
          : await retireAgentRelease(id, owner);
    return Response.json({ release }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return releaseErrorResponse(error);
  }
}

function releaseOwner(auth: Awaited<ReturnType<typeof authorizeRequest>>) {
  const binding = canonicalRequestActorBindingFromSecurityContext(auth);
  return binding ? {
    tenantId: auth.tenantId,
    actorId: auth.actorId,
    canonicalActorId: binding.canonicalActorId,
  } : undefined;
}

function canonicalActorUnavailableResponse() {
  return Response.json({
    error: "Canonical Agent release ownership could not be verified.",
  }, { status: 409, headers: privateNoStoreHeaders });
}

function releaseErrorResponse(error: unknown) {
  if (error instanceof AgentReleaseConflictError) {
    return Response.json({ error: error.message }, {
      status: 409,
      headers: privateNoStoreHeaders,
    });
  }
  if (error instanceof AgentReleaseUnavailableError) {
    return Response.json({ error: error.message }, {
      status: 503,
      headers: privateNoStoreHeaders,
    });
  }
  throw error;
}
