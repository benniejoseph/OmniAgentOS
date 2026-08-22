import { z } from "zod";
import { discoverMcpTools } from "@/lib/connectors/mcp-client";
import { mcpContractReviewSummary } from "@/lib/connectors/contract-review";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  createMcpConnectorRecord,
  getMcpConnectorStats,
  listMcpConnectors,
  listMcpConnectorsRequiringReview,
  listMcpTools,
  recordMcpConnectorError,
  saveMcpConnector,
  saveMcpDiscovery,
} from "@/lib/connectors/store";
import { evaluateConnectorSecretBinding } from "@/lib/connectors/secret-binding";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { assertPublicHttpUrl } from "@/lib/security/network";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const registerConnectorSchema = z.object({
  name: z.string().min(1).max(120),
  endpoint: z.string().url().max(2048),
  authType: z.enum(["none", "bearer_env"]).optional(),
  authTokenEnv: z.string().regex(/^[A-Z0-9_]+$/).max(120).optional(),
  defaultRiskLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  approvalRequired: z.boolean().optional(),
  discover: z.boolean().optional(),
}).strict();

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

  const [recentConnectors, reviewConnectors, tools, stats] = await Promise.all([
    listMcpConnectors(20, { tenantId: context.tenantId }),
    listMcpConnectorsRequiringReview({ tenantId: context.tenantId }),
    listMcpTools(undefined, { tenantId: context.tenantId }),
    getMcpConnectorStats({ tenantId: context.tenantId }),
  ]);
  const connectors = [
    ...new Map(
      [...reviewConnectors, ...recentConnectors].map((connector) => [
        connector.id,
        connector,
      ]),
    ).values(),
  ];

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
  });
}

async function POSTHandler(request: Request) {
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
  if ((parsed.data.authType || "none") === "bearer_env" && !parsed.data.authTokenEnv) {
    return Response.json(
      { error: "Invalid MCP connector request", message: "Bearer auth requires authTokenEnv." },
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
    envName: parsed.data.authTokenEnv,
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

  const connector = await saveMcpConnector(
    createMcpConnectorRecord({
      name: parsed.data.name,
      tenantId: context.tenantId,
      endpoint: parsed.data.endpoint,
      authType: parsed.data.authType || "none",
      authTokenEnv: parsed.data.authTokenEnv,
      defaultRiskLevel: parsed.data.defaultRiskLevel ?? 2,
      approvalRequired: parsed.data.approvalRequired ?? true,
    }),
  );

  if (!parsed.data.discover) {
    return Response.json({ connector: redactMcpConnector(connector), tools: [] }, { status: 201 });
  }

  try {
    const discovery = await discoverMcpTools(connector, { actorRole: context.role });
    const saved = await saveMcpDiscovery({
      connector,
      tools: discovery.tools,
      capabilities: discovery.capabilities,
      instructions: discovery.instructions,
      serverVersion: discovery.serverVersion,
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
        connector: redactMcpConnector(await recordMcpConnectorError(connector, message)),
        tools: [],
        error: message,
      },
      { status: 202 },
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
