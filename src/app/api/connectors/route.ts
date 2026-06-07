import { z } from "zod";
import { discoverMcpTools } from "@/lib/connectors/mcp-client";
import {
  createMcpConnectorRecord,
  getMcpConnectorStats,
  listMcpConnectors,
  listMcpTools,
  recordMcpConnectorError,
  saveMcpConnector,
  saveMcpDiscovery,
} from "@/lib/connectors/store";
import { validateConnectorSecretEnvName } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { assertPublicHttpUrl } from "@/lib/security/network";

export const runtime = "nodejs";

const registerConnectorSchema = z.object({
  name: z.string().min(1).max(120),
  endpoint: z.string().url(),
  authType: z.enum(["none", "bearer_env"]).optional(),
  authTokenEnv: z.string().regex(/^[A-Z0-9_]+$/).optional(),
  defaultRiskLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  approvalRequired: z.boolean().optional(),
  discover: z.boolean().optional(),
});

export async function GET(request: Request) {
  try {
    await authorizeRequest({
      request,
      action: "read",
      resourceType: "mcp_connector",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const [connectors, tools, stats] = await Promise.all([
    listMcpConnectors(),
    listMcpTools(),
    getMcpConnectorStats(),
  ]);

  return Response.json({
    connectors: connectors.map(redactMcpConnector),
    tools,
    stats: {
      ...stats,
      latest: stats.latest.map(redactMcpConnector),
    },
  });
}

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = registerConnectorSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid MCP connector request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!validateConnectorSecretEnvName(parsed.data.authTokenEnv)) {
    return Response.json(
      {
        error: "Invalid connector secret env var",
        message: "Connector secrets must use OMNIAGENT_CONNECTOR_* or OMNIAGENT_CONNECTOR_SECRET_ALLOWLIST and cannot reference platform secrets.",
      },
      { status: 400 },
    );
  }

  try {
    await assertPublicHttpUrl(parsed.data.endpoint, "MCP endpoint");
  } catch (error) {
    return Response.json(
      { error: "Invalid MCP endpoint", message: error instanceof Error ? error.message : "Endpoint is not allowed." },
      { status: 400 },
    );
  }

  try {
    await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "mcp_connector",
      metadata: body,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const connector = await saveMcpConnector(
    createMcpConnectorRecord({
      name: parsed.data.name,
      endpoint: parsed.data.endpoint,
      authType: parsed.data.authType || "none",
      authTokenEnv: parsed.data.authTokenEnv,
      defaultRiskLevel: parsed.data.defaultRiskLevel ?? 2,
      approvalRequired: parsed.data.approvalRequired ?? true,
    }),
  );

  if (!parsed.data.discover) {
    return Response.json({ connector, tools: [] }, { status: 201 });
  }

  try {
    const discovery = await discoverMcpTools(connector);
    const saved = await saveMcpDiscovery({
      connector,
      tools: discovery.tools,
      capabilities: discovery.capabilities,
      instructions: discovery.instructions,
      serverVersion: discovery.serverVersion,
    });
    return Response.json(saved, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP discovery failed.";
    return Response.json(
      {
        connector: await recordMcpConnectorError(connector, message),
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
