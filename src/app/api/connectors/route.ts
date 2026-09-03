import { z } from "zod";
import { discoverMcpTools } from "@/lib/connectors/mcp-client";
import { mcpContractReviewSummary } from "@/lib/connectors/contract-review";
import {
  McpCredentialStoreError,
  storeMcpBearerCredential,
} from "@/lib/connectors/credential-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  createMcpConnectorRecord,
  deleteMcpConnector,
  getMcpConnector,
  listMcpConnectors,
  listMcpTools,
  recordMcpConnectorError,
  saveMcpConnector,
  saveMcpDiscovery,
} from "@/lib/connectors/store";
import { evaluateConnectorSecretBinding } from "@/lib/connectors/secret-binding";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { createRequestTelemetry } from "@/lib/observability/store";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { assertPublicHttpUrl } from "@/lib/security/network";
import {
  CredentialVaultUnavailableError,
  credentialVaultStatus,
} from "@/lib/settings/credential-vault";
import type { McpConnectorRecord } from "@/lib/connectors/types";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const registerConnectorSchema = z.object({
  name: z.string().min(1).max(120),
  endpoint: z.string().url().max(2048),
  authType: z.enum(["none", "bearer_env", "bearer_vault"]).optional(),
  authTokenEnv: z.string().regex(/^[A-Z0-9_]+$/).max(120).optional(),
  bearerToken: z.string().min(8).max(8_192).refine((value) => !/[\r\n]/.test(value), {
    message: "Bearer token must be a single-line value.",
  }).refine((value) => value.trim() === value, {
    message: "Bearer token cannot have leading or trailing whitespace.",
  }).optional(),
  defaultRiskLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  approvalRequired: z.boolean().optional(),
  discover: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const authType = value.authType || "none";
  if (authType === "bearer_env" && !value.authTokenEnv) {
    context.addIssue({
      code: "custom",
      path: ["authTokenEnv"],
      message: "Environment bearer auth requires authTokenEnv.",
    });
  }
  if (authType === "bearer_vault" && !value.bearerToken) {
    context.addIssue({
      code: "custom",
      path: ["bearerToken"],
      message: "App-managed bearer auth requires bearerToken.",
    });
  }
  if (authType !== "bearer_env" && value.authTokenEnv) {
    context.addIssue({
      code: "custom",
      path: ["authTokenEnv"],
      message: "authTokenEnv is only valid with bearer_env.",
    });
  }
  if (authType !== "bearer_vault" && value.bearerToken) {
    context.addIssue({
      code: "custom",
      path: ["bearerToken"],
      message: "bearerToken is only accepted with bearer_vault.",
    });
  }
});

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "mcp_connector",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const [allConnectors, tools] = await Promise.all([
    listMcpConnectors(100, { tenantId: context.tenantId }),
    listMcpTools(undefined, { tenantId: context.tenantId }),
  ]);
  const reviewConnectorIds = new Set(
    tools.filter((tool) => tool.status === "pending_review").map((tool) => tool.connectorId),
  );
  const reviewConnectors = allConnectors.filter((connector) => reviewConnectorIds.has(connector.id));
  const recentConnectors = allConnectors.slice(0, 20);
  const connectors = [
    ...new Map(
      [...reviewConnectors, ...recentConnectors].map((connector) => [
        connector.id,
        connector,
      ]),
    ).values(),
  ];
  const activeConnectorIds = new Set(
    allConnectors.filter((connector) => connector.status === "active").map((connector) => connector.id),
  );
  const stats = {
    total: allConnectors.length,
    active: activeConnectorIds.size,
    error: allConnectors.filter((connector) => connector.status === "error").length,
    toolCount: tools.filter((tool) => tool.status === "active" && activeConnectorIds.has(tool.connectorId)).length,
    latest: allConnectors.slice(0, 5),
  };

  const vaultStatus = credentialVaultStatus();
  return Response.json({
    connectors: connectors.map((connector) => ({
      ...redactMcpConnector(connector),
      review: mcpContractReviewSummary(
        tools.filter((tool) => tool.connectorId === connector.id),
        connector,
      ),
    })),
    tools,
    stats: {
      ...stats,
      latest: stats.latest.map(redactMcpConnector),
    },
    credentialVault: {
      configured: vaultStatus.configured,
      message: vaultStatus.message,
    },
  });
}

async function POSTHandler(request: Request) {
  const telemetry = createRequestTelemetry(request, "mcp_connector");
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = registerConnectorSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid MCP connector request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "mcp_connector",
      metadata: {
        name: parsed.data.name,
        authType: parsed.data.authType || "none",
        hasSecretBinding: Boolean(parsed.data.authTokenEnv),
        hasAppManagedCredential: Boolean(parsed.data.bearerToken),
        defaultRiskLevel: parsed.data.defaultRiskLevel ?? 2,
        approvalRequired: parsed.data.approvalRequired ?? true,
        discover: Boolean(parsed.data.discover),
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    await assertPublicHttpUrl(parsed.data.endpoint, "MCP endpoint");
  } catch (error) {
    return Response.json(
      { error: "Invalid MCP endpoint", message: error instanceof Error ? error.message : "Endpoint is not allowed." },
      { status: 400 },
    );
  }

  const secretBinding = evaluateConnectorSecretBinding({
    envName: parsed.data.authType === "bearer_env" ? parsed.data.authTokenEnv : undefined,
    tenantId: context.tenantId,
    targetUrl: parsed.data.endpoint,
    role: context.role,
  });
  if (!secretBinding.allowed) {
    return Response.json(
      { error: "Invalid connector secret binding", message: secretBinding.reason },
      { status: 400 },
    );
  }

  if (parsed.data.authType === "bearer_vault" && !credentialVaultStatus().configured) {
    return connectorCredentialErrorResponse(new CredentialVaultUnavailableError());
  }

  let connector: McpConnectorRecord = await saveMcpConnector(
    createMcpConnectorRecord({
      name: parsed.data.name,
      tenantId: context.tenantId,
      endpoint: parsed.data.endpoint,
      authType: parsed.data.authType || "none",
      authTokenEnv: parsed.data.authTokenEnv,
      defaultRiskLevel: parsed.data.defaultRiskLevel ?? 2,
      approvalRequired: parsed.data.approvalRequired ?? true,
    }),
    {
      executionScope: executionScopeFromSecurityContext(context, {
        correlationId: telemetry.correlationId,
        purpose: "connector.mcp.create",
      }),
    },
  );

  if (parsed.data.authType === "bearer_vault") {
    try {
      await storeMcpBearerCredential({
        tenantId: context.tenantId,
        connectorId: connector.id,
        endpoint: connector.endpoint,
        bearerToken: parsed.data.bearerToken!,
        executionScope: executionScopeFromSecurityContext(context, {
          correlationId: telemetry.correlationId,
          causationId: connector.id,
          purpose: "connector.mcp.credential.save",
        }),
      });
      connector = (await getMcpConnector(connector.id, { tenantId: context.tenantId }))!;
    } catch (error) {
      await deleteMcpConnector(connector.id, {
        executionScope: executionScopeFromSecurityContext(context, {
          correlationId: telemetry.correlationId,
          causationId: connector.id,
          purpose: "connector.mcp.create.rollback",
        }),
      }).catch(() => undefined);
      return connectorCredentialErrorResponse(error);
    }
  }

  if (!parsed.data.discover) {
    return Response.json({ connector: redactMcpConnector(connector), tools: [] }, { status: 201 });
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
    }, {
      executionScope: executionScopeFromSecurityContext(context, {
        correlationId: telemetry.correlationId,
        causationId: connector.id,
        purpose: "connector.mcp.discover",
      }),
    });
    return Response.json(
      {
        ...saved,
        connector: {
          ...redactMcpConnector(saved.connector),
          review: mcpContractReviewSummary(saved.tools, saved.connector),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP discovery failed.";
    return Response.json(
      {
        connector: redactMcpConnector(await recordMcpConnectorError(
          connector,
          message,
          {
            executionScope: executionScopeFromSecurityContext(context, {
              correlationId: telemetry.correlationId,
              causationId: connector.id,
              purpose: "connector.mcp.discovery_error.record",
            }),
          },
        )),
        tools: [],
        error: message,
        discoveryFailed: true,
        connectionCreated: true,
        credentialSaved:
          connector.authType === "bearer_vault" &&
          Boolean(connector.credentialConfigured),
      },
      { status: 502 },
    );
  }
}

function redactMcpConnector<T extends { authTokenEnv?: string; lastError?: string }>(connector: T) {
  return {
    ...connector,
    authTokenEnv: connector.authTokenEnv ? "[configured]" : undefined,
    lastError: connector.lastError ? "[redacted]" : undefined,
  };
}

function connectorCredentialErrorResponse(error: unknown) {
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
      message: "The app-managed MCP credential could not be saved safely.",
    },
    { status: 500 },
  );
}
