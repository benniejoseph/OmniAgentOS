import { randomUUID } from "node:crypto";
import { z } from "zod";

import { discoverExternalA2APeerV1 } from "@/lib/a2a/client";
import {
  A2APeerStoreError,
  listA2APeers,
  registerA2APeer,
} from "@/lib/a2a/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { CredentialVaultUnavailableError } from "@/lib/settings/credential-vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const registerSchema = z.object({
  peerId: z.string().trim().min(1).max(240).regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
  ),
  baseUrl: z.string().url().max(2_048),
  interfaceUrl: z.string().url().max(2_048).optional(),
  direction: z.enum(["inbound", "outbound", "bidirectional"]),
  mode: z.enum(["shadow", "enabled"]).default("shadow"),
  inboundServiceApiKeyId: z.string().trim().min(1).max(240).optional(),
  outboundBearerToken: z.string().min(8).max(8_192).refine(
    (value) => value.trim() === value && !/[\r\n\s]/.test(value),
    "A2A Bearer token must be a single token without whitespace.",
  ).optional(),
  allowedSkillIds: z.array(z.string().trim().min(1).max(240)).min(1).max(64),
  maxTaskDurationMs: z.number().int().min(1_000).max(3_600_000).optional(),
  maxInputBytes: z.number().int().min(1).max(1_000_000).optional(),
  maxOutputBytes: z.number().int().min(1).max(2_000_000).optional(),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "mcp_connector",
      metadata: { protocol: "a2a", operation: "list_peers" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    return Response.json({
      version: "p8.6-a2a-peer-collection:1",
      peers: await listA2APeers({
        tenantId: context.tenantId,
        ownerActorId: context.actorId,
      }),
    }, { headers: privateNoStoreHeaders() });
  } catch (error) {
    return peerErrorResponse(error);
  }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid A2A peer registration.", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders() },
    );
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "mcp_connector",
      riskLevel: 2,
      metadata: {
        protocol: "a2a",
        operation: "register_peer",
        peerId: parsed.data.peerId,
        direction: parsed.data.direction,
        mode: parsed.data.mode,
        hasInboundServiceIdentity: Boolean(parsed.data.inboundServiceApiKeyId),
        hasOutboundCredential: Boolean(parsed.data.outboundBearerToken),
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const discovery = await discoverExternalA2APeerV1({
      baseUrl: parsed.data.baseUrl,
      abortSignal: request.signal,
    });
    const interfaceUrl = parsed.data.interfaceUrl || discovery.selectedInterface.url;
    const rollout = await registerA2APeer({
      tenantId: context.tenantId,
      ownerActorId: context.actorId,
      peerId: parsed.data.peerId,
      direction: parsed.data.direction,
      mode: parsed.data.mode,
      card: discovery.card,
      interfaceUrl,
      inboundServiceApiKeyId: parsed.data.inboundServiceApiKeyId,
      outboundBearerToken: parsed.data.outboundBearerToken,
      allowedSkillIds: parsed.data.allowedSkillIds,
      maxTaskDurationMs: parsed.data.maxTaskDurationMs,
      maxInputBytes: parsed.data.maxInputBytes,
      maxOutputBytes: parsed.data.maxOutputBytes,
      executionScope: executionScopeFromSecurityContext(context, {
        correlationId: `a2a-peer-register:${randomUUID()}`,
        purpose: "a2a.peer.register.v1",
      }),
    });
    return Response.json({ rollout }, {
      status: 201,
      headers: privateNoStoreHeaders(),
    });
  } catch (error) {
    return peerErrorResponse(error);
  }
}

function peerErrorResponse(error: unknown) {
  const status = error instanceof A2APeerStoreError ||
      error instanceof CredentialVaultUnavailableError
    ? error.status
    : 400;
  const message = error instanceof A2APeerStoreError ||
      error instanceof CredentialVaultUnavailableError
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
