import {
  listMoltbookConnection,
  MoltbookConnectionError,
  pauseMoltbookConnection,
  refreshMoltbookConnection,
  registerMoltbookConnection,
  resolveMoltbookAgentOwner,
  resumeMoltbookConnection,
} from "@/lib/moltbook/store";
import {
  MOLTBOOK_AUTONOMY_DISCLOSURE_VERSION,
  MOLTBOOK_TOOL_IDS,
  moltbookRouteActionSchema,
} from "@/lib/moltbook/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { resolveAgentIdentityForExecution } from "@/lib/agents/identity-store";
import { moltbookConnectionIdentityPinFromIdentity } from "@/lib/moltbook/identity-boundary";
import {
  enableMoltbookAutonomy,
  insertCurrentMoltbookAuthorityVersion,
  listMoltbookAutonomyProjection,
  MoltbookAutonomyStoreError,
  pauseMoltbookAutonomy,
  resumeMoltbookAutonomy,
  revokeMoltbookAutonomy,
} from "@/lib/moltbook/autonomy-store";
import {
  MOLTBOOK_AUTONOMY_CHARTER_SHA256,
  runMoltbookAutonomyOnce,
} from "@/lib/moltbook/autonomy-runner";
import { getCustomAgent, updateCustomAgent } from "@/lib/skills/store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const runtime = "nodejs";
export const maxDuration = 300;
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
    const autonomy = await listMoltbookAutonomyProjection({
      owner,
      agentId: id,
    });
    return Response.json({ ...result, autonomy }, {
      headers: privateNoStoreHeaders,
    });
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
      nativeMutationCapability: "agents.moltbook.manage",
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
    const identityPin = parsed.data.action === "register"
      ? moltbookConnectionIdentityPinFromIdentity(
          await resolveAgentIdentityForExecution({
            tenantId: auth.tenantId,
            actorId: auth.actorId,
            agentId: id,
          }),
        )
      : undefined;
    if (
      identityPin &&
      identityPin.logicalAgentId !== id
    ) {
      throw new MoltbookConnectionError(
        "The active Agent identity does not match this connection.",
        { code: "connection_identity_pin_mismatch" },
      );
    }
    let result;
    if (parsed.data.action === "enable_autonomy") {
      result = await enableAutonomy({
        owner,
        agentId: id,
        canonicalActorId: ownerBinding.canonicalActorId,
      });
    } else if (parsed.data.action === "pause_autonomy") {
      await pauseMoltbookAutonomy({ owner, agentId: id });
      result = await connectionAndAutonomy(owner, id);
    } else if (parsed.data.action === "resume_autonomy") {
      await requireClaimedMoltbookConnection(owner, id);
      const autonomy = await listMoltbookAutonomyProjection({
        owner,
        agentId: id,
      });
      if (!autonomy.enrollment || !autonomy.executable) {
        throw new MoltbookAutonomyStoreError(
          "Moltbook autonomy cannot resume because its standing authority is missing or stale. Enable autonomy again to refresh it.",
          "stale_authority",
        );
      }
      await resumeMoltbookAutonomy({ owner, agentId: id });
      result = await connectionAndAutonomy(owner, id);
    } else if (parsed.data.action === "revoke_autonomy") {
      await revokeMoltbookAutonomy({ owner, agentId: id });
      result = await connectionAndAutonomy(owner, id);
    } else if (parsed.data.action === "run_autonomy_once") {
      const cycle = await runMoltbookAutonomyOnce({
        owner,
        agentId: id,
        abortSignal: request.signal,
      });
      result = { ...(await connectionAndAutonomy(owner, id)), cycle };
    } else {
      result = parsed.data.action === "register"
      ? await registerMoltbookConnection({
          owner,
          agentId: id,
          identityPin: identityPin!,
          externalName: parsed.data.externalName,
          description: parsed.data.description,
          heartbeatEnabled: parsed.data.heartbeatEnabled,
          disclosureAccepted: parsed.data.disclosureAccepted,
          disclosureVersion: parsed.data.disclosureVersion,
        })
      : parsed.data.action === "refresh"
        ? { connection: await refreshMoltbookConnection({ owner, agentId: id }) }
        : parsed.data.action === "pause"
          ? await pauseConnectionAndAutonomy(owner, id)
          : { connection: await resumeMoltbookConnection({ owner, agentId: id }) };
      result = parsed.data.action === "register"
        ? result
        : { ...result, autonomy: await listMoltbookAutonomyProjection({
            owner,
            agentId: id,
          }) };
    }
    return Response.json(result, { headers: privateNoStoreHeaders });
  } catch (error) {
    return moltbookErrorResponse(error);
  }
}

async function enableAutonomy(input: {
  owner: { tenantId: string; actorId: string };
  agentId: string;
  canonicalActorId: string;
}) {
  await requireClaimedMoltbookConnection(input.owner, input.agentId);
  const current = await getCustomAgent(input.agentId, input.owner);
  if (!current) {
    throw new MoltbookConnectionError("The Moltbook Agent was not found.", {
      status: 404,
      code: "agent_not_found",
    });
  }
  let transitionStaged = false;
  try {
    // Pausing the connection is the durable fail-closed marker for the
    // multi-store capability/identity/authority transition. No provider
    // effect or autonomous run can start until the exact new authority is
    // persisted and the connection is resumed below.
    await pauseMoltbookConnection({ owner: input.owner, agentId: input.agentId });
    transitionStaged = true;
    const hasCurrentTools =
      current.toolIds.length === MOLTBOOK_TOOL_IDS.length &&
      MOLTBOOK_TOOL_IDS.every((toolId) => current.toolIds.includes(toolId));
    if (!hasCurrentTools) {
      const upgraded = await updateCustomAgent(input.agentId, {
        toolIds: [...MOLTBOOK_TOOL_IDS],
      }, input.owner);
      if (!upgraded) {
        throw new MoltbookConnectionError(
          "The Moltbook Agent capability upgrade did not complete.",
          { status: 409, code: "agent_capability_upgrade_failed" },
        );
      }
    }
    const identity = await resolveAgentIdentityForExecution({
      tenantId: input.owner.tenantId,
      actorId: input.owner.actorId,
      agentId: input.agentId,
    });
    const connectionPin = moltbookConnectionIdentityPinFromIdentity(identity);
    if (connectionPin.logicalAgentId !== input.agentId) {
      throw new MoltbookConnectionError(
        "The upgraded Agent identity does not match this connection.",
        { status: 409, code: "connection_identity_pin_mismatch" },
      );
    }
    await insertCurrentMoltbookAuthorityVersion({
      owner: input.owner,
      agentId: input.agentId,
      pin: {
        agentId: connectionPin.logicalAgentId,
        principalId: connectionPin.principalId,
        principalGeneration: connectionPin.principalGeneration,
        principalSha256: connectionPin.principalSha256,
        definitionVersion: connectionPin.definitionVersion,
        definitionSha256: connectionPin.definitionSha256,
        policyBoundarySha256: connectionPin.policyBoundarySha256,
      },
      changeRequestSha256: canonicalJsonSha256({
        action: "enable_moltbook_autonomy",
        agentId: input.agentId,
        canonicalActorId: input.canonicalActorId,
        disclosureVersion: MOLTBOOK_AUTONOMY_DISCLOSURE_VERSION,
        toolIds: [...MOLTBOOK_TOOL_IDS],
        charterSha256: MOLTBOOK_AUTONOMY_CHARTER_SHA256,
      }),
      reason: "agent_rebind",
    });
    await resumeMoltbookConnection({ owner: input.owner, agentId: input.agentId });
    await enableMoltbookAutonomy({
      owner: input.owner,
      agentId: input.agentId,
      authorizedByCanonicalActorId: input.canonicalActorId,
      charterSha256: MOLTBOOK_AUTONOMY_CHARTER_SHA256,
    });
    return connectionAndAutonomy(input.owner, input.agentId);
  } catch (error) {
    if (transitionStaged) {
      await pauseMoltbookAutonomy({
        owner: input.owner,
        agentId: input.agentId,
      }).catch(() => undefined);
      await pauseMoltbookConnection({
        owner: input.owner,
        agentId: input.agentId,
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function pauseConnectionAndAutonomy(
  owner: { tenantId: string; actorId: string },
  agentId: string,
) {
  await pauseMoltbookAutonomy({ owner, agentId }).catch((error) => {
    if (!(error instanceof MoltbookAutonomyStoreError) || error.code !== "not_found") {
      throw error;
    }
  });
  const connection = await pauseMoltbookConnection({ owner, agentId });
  return { connection };
}

async function requireClaimedMoltbookConnection(
  owner: { tenantId: string; actorId: string },
  agentId: string,
) {
  const { connection } = await listMoltbookConnection({ owner, agentId });
  if (
    !connection ||
    connection.status !== "claimed" ||
    connection.claimState !== "claimed" ||
    !connection.credentialConfigured
  ) {
    throw new MoltbookConnectionError(
      "Resume and claim the Moltbook connection before enabling autonomous activity.",
      { status: 409, code: "autonomy_connection_unavailable" },
    );
  }
  return connection;
}

async function connectionAndAutonomy(
  owner: { tenantId: string; actorId: string },
  agentId: string,
) {
  const [connection, autonomy] = await Promise.all([
    listMoltbookConnection({ owner, agentId }),
    listMoltbookAutonomyProjection({ owner, agentId }),
  ]);
  return { ...connection, autonomy };
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
  if (error instanceof MoltbookAutonomyStoreError) {
    const status = error.code === "database_required"
      ? 503
      : error.code === "invalid_input"
        ? 400
        : error.code === "not_found"
          ? 404
          : error.code === "budget_exhausted" || error.code === "cooldown_active"
            ? 429
            : 409;
    return Response.json({ error: error.message, code: error.code }, {
      status,
      headers: privateNoStoreHeaders,
    });
  }
  if (error instanceof MoltbookConnectionError) {
    return Response.json({ error: error.message, code: error.code }, {
      status: error.status,
      headers: privateNoStoreHeaders,
    });
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code || "");
    if (/^[a-z0-9_]{1,80}$/.test(code)) {
      return Response.json({
        error: error instanceof Error ? error.message : "The autonomy cycle failed.",
        code,
      }, { status: 409, headers: privateNoStoreHeaders });
    }
  }
  return Response.json({ error: "The Moltbook Agent operation failed." }, {
    status: 500,
    headers: privateNoStoreHeaders,
  });
}
