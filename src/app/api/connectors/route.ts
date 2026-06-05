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

export async function GET() {
  return Response.json({
    connectors: await listMcpConnectors(),
    tools: await listMcpTools(),
    stats: await getMcpConnectorStats(),
  });
}

export async function POST(request: Request) {
  const parsed = registerConnectorSchema.safeParse(await request.json());

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid MCP connector request", details: parsed.error.flatten() },
      { status: 400 },
    );
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
