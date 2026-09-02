import { z } from "zod";
import { mcpContractReviewSummary } from "@/lib/connectors/contract-review";
import {
  McpCredentialStoreError,
  removeMcpBearerCredential,
  storeMcpBearerCredential,
} from "@/lib/connectors/credential-store";
import { discoverMcpTools } from "@/lib/connectors/mcp-client";
import {
  getMcpConnector,
  recordMcpConnectorError,
  saveMcpDiscovery,
} from "@/lib/connectors/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { assertPublicHttpUrl } from "@/lib/security/network";
import { CredentialVaultUnavailableError } from "@/lib/settings/credential-vault";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const rotateCredentialSchema = z.object({
  bearerToken: z.string().min(8).max(8_192).refine((value) => !/[\r\n]/.test(value), {
    message: "Bearer token must be a single-line value.",
  }).refine((value) => value.trim() === value, {
    message: "Bearer token cannot have leading or trailing whitespace.",
  }),
  discover: z.boolean().optional().default(false),
}).strict();

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request, 12_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = rotateCredentialSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid MCP credential rotation", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "mcp_connector_credential",
      resourceId: id,
      riskLevel: 2,
      metadata: {
        operation: "rotate_app_managed_bearer",
        discover: parsed.data.discover,
        credentialProvided: true,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const existing = await getMcpConnector(id, { tenantId: context.tenantId });
  if (!existing) {
    return Response.json({ error: "MCP connector not found." }, { status: 404 });
  }
  try {
    await assertPublicHttpUrl(existing.endpoint, "MCP endpoint");
  } catch (error) {
    return Response.json(
      {
        error: "Invalid MCP endpoint",
        message: error instanceof Error ? error.message : "Endpoint is not allowed.",
      },
      { status: 400 },
    );
  }
  try {
    await storeMcpBearerCredential({
      tenantId: context.tenantId,
      actorId: context.actorId,
      connectorId: id,
      endpoint: existing.endpoint,
      bearerToken: parsed.data.bearerToken,
    });
  } catch (error) {
    return credentialErrorResponse(error);
  }

  const connector = await getMcpConnector(id, { tenantId: context.tenantId });
  if (!connector) {
    return Response.json({ error: "MCP connector not found." }, { status: 404 });
  }
  if (!parsed.data.discover) {
    return Response.json({
      connector: redactMcpConnector(connector),
      rediscoveryRequired: true,
      reviewRequired: true,
      message: "Credential saved. Rediscover and review the MCP tool contracts before enabling this connector.",
    });
  }

  try {
    const discovery = await discoverMcpTools(connector, {
      actorId: context.actorId,
      actorRole: context.role,
    });
    const saved = await saveMcpDiscovery({
      connector,
      tools: discovery.tools,
      capabilities: discovery.capabilities,
      instructions: discovery.instructions,
      serverVersion: discovery.serverVersion,
    });
    return Response.json({
      connector: {
        ...redactMcpConnector(saved.connector),
        review: mcpContractReviewSummary(saved.tools, saved.connector),
      },
      tools: saved.tools,
      rediscoveryRequired: false,
      reviewRequired: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP discovery failed.";
    return Response.json(
      {
        connector: redactMcpConnector(await recordMcpConnectorError(connector, message)),
        tools: [],
        error: message,
        discoveryFailed: true,
        credentialSaved: true,
      },
      { status: 502 },
    );
  }
}

async function DELETEHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "mcp_connector_credential",
      resourceId: id,
      riskLevel: 2,
      metadata: { operation: "remove_app_managed_bearer" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const removed = await removeMcpBearerCredential({
      tenantId: context.tenantId,
      actorId: context.actorId,
      connectorId: id,
    });
    const connector = await getMcpConnector(id, { tenantId: context.tenantId });
    return Response.json({
      removed: removed.removed,
      connector: connector ? redactMcpConnector(connector) : undefined,
      externalCredentialRevoked: false,
      message:
        "The encrypted credential was removed from OmniAgent and the connector was disabled. " +
        "The external token was not revoked; revoke it with the provider if it should no longer be valid.",
    });
  } catch (error) {
    return credentialErrorResponse(error);
  }
}

function redactMcpConnector<T extends { authTokenEnv?: string; lastError?: string }>(connector: T) {
  return {
    ...connector,
    authTokenEnv: connector.authTokenEnv ? "[configured]" : undefined,
    lastError: connector.lastError ? "[redacted]" : undefined,
  };
}

function credentialErrorResponse(error: unknown) {
  if (
    error instanceof CredentialVaultUnavailableError ||
    error instanceof McpCredentialStoreError
  ) {
    return Response.json(
      { error: error.name, message: error.message },
      { status: error.status },
    );
  }
  console.error(
    "MCP connector credential operation failed.",
    error instanceof Error ? error.name : "UnknownError",
  );
  return Response.json(
    {
      error: "MCP connector credential operation failed",
      message: "The app-managed MCP credential operation could not be completed safely.",
    },
    { status: 500 },
  );
}
