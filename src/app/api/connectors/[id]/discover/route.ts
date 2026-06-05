import { discoverMcpTools } from "@/lib/connectors/mcp-client";
import {
  getMcpConnector,
  recordMcpConnectorError,
  saveMcpDiscovery,
} from "@/lib/connectors/store";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const connector = await getMcpConnector(id);

  if (!connector) {
    return Response.json({ error: "MCP connector not found." }, { status: 404 });
  }

  try {
    const discovery = await discoverMcpTools(connector);
    return Response.json(
      await saveMcpDiscovery({
        connector,
        tools: discovery.tools,
        capabilities: discovery.capabilities,
        instructions: discovery.instructions,
        serverVersion: discovery.serverVersion,
      }),
    );
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
