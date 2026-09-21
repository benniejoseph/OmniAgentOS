import {
  listMoltbookConnection,
  MoltbookConnectionError,
  pauseMoltbookConnection,
  refreshMoltbookConnection,
  registerMoltbookConnection,
  retryMoltbookRegistration,
  resolveMoltbookAgentOwner,
  resumeMoltbookConnection,
} from "@/lib/moltbook/store";
import { moltbookRouteActionSchema } from "@/lib/moltbook/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
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
      resourceType: "moltbook_agent_connection",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const ownerBinding = canonicalRequestActorBindingFromSecurityContext(auth);
  if (!ownerBinding) return ownerUnavailableResponse();
  const url = new URL(request.url);
  const parsedLimit = parseLimit(url.searchParams.get("limit"));
  if (parsedLimit === null) {
    return Response.json({ error: "Invalid activity limit." }, {
      status: 400,
      headers: privateNoStoreHeaders,
    });
  }
  const cursor = url.searchParams.get("cursor") || undefined;
  if (cursor && cursor.length > 500) {
    return Response.json({ error: "Invalid activity cursor." }, {
      status: 400,
      headers: privateNoStoreHeaders,
    });
  }
  const { id } = await context.params;
  try {
    const owner = await resolveMoltbookAgentOwner({
      tenantId: auth.tenantId,
      agentId: id,
      readableOwnerActorIds: ownerBinding.readableOwnerActorIds,
    });
    const result = await listMoltbookConnection({
      owner,
      agentId: id,
      limit: parsedLimit || undefined,
      cursor,
    });
    return Response.json(result, { headers: privateNoStoreHeaders });
  } catch (error) {
    return moltbookErrorResponse(error);
  }
}

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  // This route is the authenticated human control plane for connection setup.
  // Agent-authored social effects remain exclusive to the governed tool executor.
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "moltbook_agent_connection",
      metadata: { operation: "manage_moltbook_connection" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const ownerBinding = canonicalRequestActorBindingFromSecurityContext(auth);
  if (!ownerBinding) return ownerUnavailableResponse();
  let body: unknown;
  try {
    body = await parseJsonBody(request, 4_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = moltbookRouteActionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid Moltbook Agent action.",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  const { id } = await context.params;
  try {
    const owner = await resolveMoltbookAgentOwner({
      tenantId: auth.tenantId,
      agentId: id,
      readableOwnerActorIds: ownerBinding.readableOwnerActorIds,
    });
    const result = parsed.data.action === "register"
      ? await registerMoltbookConnection({
          owner,
          agentId: id,
          externalName: parsed.data.externalName,
          description: parsed.data.description,
          heartbeatEnabled: parsed.data.heartbeatEnabled,
          disclosureAccepted: parsed.data.disclosureAccepted,
          disclosureVersion: parsed.data.disclosureVersion,
        })
      : parsed.data.action === "retry_registration"
        ? await retryMoltbookRegistration({
            owner,
            agentId: id,
            externalName: parsed.data.externalName,
            description: parsed.data.description,
            heartbeatEnabled: parsed.data.heartbeatEnabled,
            disclosureAccepted: parsed.data.disclosureAccepted,
            disclosureVersion: parsed.data.disclosureVersion,
          })
      : parsed.data.action === "refresh"
        ? { connection: await refreshMoltbookConnection({ owner, agentId: id }) }
        : parsed.data.action === "pause"
          ? { connection: await pauseMoltbookConnection({ owner, agentId: id }) }
          : { connection: await resumeMoltbookConnection({ owner, agentId: id }) };
    return Response.json(result, { headers: privateNoStoreHeaders });
  } catch (error) {
    return moltbookErrorResponse(error);
  }
}

function parseLimit(value: string | null) {
  if (value === null || value === "") return undefined;
  if (!/^[0-9]{1,3}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= 100 ? parsed : null;
}

function ownerUnavailableResponse() {
  return Response.json({
    error: "Canonical Moltbook Agent ownership could not be verified.",
  }, { status: 409, headers: privateNoStoreHeaders });
}

function moltbookErrorResponse(error: unknown) {
  if (error instanceof MoltbookConnectionError) {
    return Response.json({ error: error.message, code: error.code }, {
      status: error.status,
      headers: privateNoStoreHeaders,
    });
  }
  return Response.json({ error: "The Moltbook Agent operation failed." }, {
    status: 500,
    headers: privateNoStoreHeaders,
  });
}
