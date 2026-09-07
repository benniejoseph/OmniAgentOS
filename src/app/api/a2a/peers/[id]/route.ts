import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  A2APeerStoreError,
  getA2APeer,
  transitionA2APeer,
} from "@/lib/a2a/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const transitionSchema = z.object({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["active", "paused", "revoked"]),
}).strict();

type RouteContext = { params: Promise<{ id: string }> };

async function GETHandler(request: Request, route: RouteContext) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "mcp_connector",
      metadata: { protocol: "a2a", operation: "get_peer" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const { id } = await route.params;
    return Response.json({
      rollout: await getA2APeer({
        tenantId: context.tenantId,
        ownerActorId: context.actorId,
        rolloutId: decodeURIComponent(id),
      }),
    }, { headers: privateNoStoreHeaders() });
  } catch (error) {
    return peerErrorResponse(error);
  }
}

async function PATCHHandler(request: Request, route: RouteContext) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = transitionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid A2A peer transition." }, {
      status: 400,
      headers: privateNoStoreHeaders(),
    });
  }
  const { id } = await route.params;
  const rolloutId = decodeURIComponent(id);
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "mcp_connector",
      resourceId: rolloutId,
      riskLevel: parsed.data.status === "active" ? 3 : 2,
      metadata: {
        protocol: "a2a",
        operation: "transition_peer",
        status: parsed.data.status,
        expectedRevision: parsed.data.expectedRevision,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const rollout = await transitionA2APeer({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      rolloutId,
      expectedRevision: parsed.data.expectedRevision,
      to: parsed.data.status,
      executionScope: executionScopeFromSecurityContext(context, {
        correlationId: `a2a-peer-transition:${randomUUID()}`,
        purpose: `a2a.peer.${parsed.data.status}.v1`,
      }),
    });
    return Response.json({ rollout }, { headers: privateNoStoreHeaders() });
  } catch (error) {
    return peerErrorResponse(error);
  }
}

function peerErrorResponse(error: unknown) {
  const status = error instanceof A2APeerStoreError ? error.status : 400;
  const message = error instanceof A2APeerStoreError
    ? error.message
    : "The A2A peer request could not be completed.";
  return Response.json({ error: message }, {
    status,
    headers: privateNoStoreHeaders(),
  });
}

function privateNoStoreHeaders() {
  return { "cache-control": "private, no-store", pragma: "no-cache" };
}
