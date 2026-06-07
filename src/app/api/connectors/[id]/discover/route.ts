import { discoverMcpTools } from "@/lib/connectors/mcp-client";
import {
  getMcpConnector,
  recordMcpConnectorError,
  saveMcpDiscovery,
} from "@/lib/connectors/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "mcp_connector",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const connector = await getMcpConnector(id, { tenantId: securityContext.tenantId });

  if (!connector) {
    return Response.json({ error: "MCP connector not found." }, { status: 404 });
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
    return Response.json({ ...saved, connector: redactMcpConnector(saved.connector) });
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
