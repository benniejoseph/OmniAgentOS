import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpConnectorRecord, McpToolRecord } from "@/lib/connectors/types";
import { createMcpToolId } from "@/lib/connectors/store";
import type { ToolRiskLevel } from "@/lib/tools/types";

const CLIENT_INFO = {
  name: "omniagent-os",
  version: "0.1.0",
};

export async function discoverMcpTools(connector: McpConnectorRecord) {
  const session = await connectMcp(connector);
  try {
    const discoveredTools = await collectTools(session.client);
    const now = new Date().toISOString();
    const tools = discoveredTools.map((tool) => toToolRecord(connector, tool, now));

    return {
      tools,
      capabilities: toPlainObject(session.client.getServerCapabilities()),
      instructions: session.client.getInstructions(),
      serverVersion: toPlainObject(session.client.getServerVersion()),
    };
  } finally {
    await closeMcp(session);
  }
}

export async function callMcpTool({
  connector,
  toolName,
  args,
}: {
  connector: McpConnectorRecord;
  toolName: string;
  args: Record<string, unknown>;
}) {
  const session = await connectMcp(connector);
  try {
    const result = await session.client.callTool(
      {
        name: toolName,
        arguments: args,
      },
      undefined,
      { timeout: 60_000 },
    );
    return toJsonValue(result);
  } finally {
    await closeMcp(session);
  }
}

async function connectMcp(connector: McpConnectorRecord) {
  if (connector.transport !== "streamable_http") {
    throw new Error(`Unsupported MCP transport: ${connector.transport}`);
  }

  const endpoint = new URL(connector.endpoint);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("MCP endpoint must use http or https.");
  }

  const client = new Client(CLIENT_INFO, {
    capabilities: {},
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: createRequestInit(connector),
  });

  await client.connect(transport, { timeout: 15_000 });
  return { client, transport };
}

async function collectTools(client: Client) {
  const tools: Tool[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.listTools({ cursor }, { timeout: 30_000 });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  return tools;
}

async function closeMcp(session: {
  client: Client;
  transport: StreamableHTTPClientTransport;
}) {
  await session.transport.terminateSession().catch(() => undefined);
  await session.client.close().catch(() => undefined);
}

function createRequestInit(connector: McpConnectorRecord): RequestInit | undefined {
  if (connector.authType !== "bearer_env") {
    return undefined;
  }

  const envName = connector.authTokenEnv?.trim();
  if (!envName) {
    throw new Error("Bearer-token MCP connector requires an auth token environment variable name.");
  }

  const token = process.env[envName];
  if (!token) {
    throw new Error(`MCP auth token environment variable ${envName} is not configured.`);
  }

  return {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}

function toToolRecord(connector: McpConnectorRecord, tool: Tool, now: string): McpToolRecord {
  const annotations = toPlainObject(tool.annotations);
  const riskLevel = inferToolRisk(connector.defaultRiskLevel, annotations);

  return {
    id: createMcpToolId(connector.id, tool.name),
    connectorId: connector.id,
    connectorName: connector.name,
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: toPlainObject(tool.inputSchema) || { type: "object" },
    outputSchema: toPlainObject(tool.outputSchema),
    annotations,
    riskLevel,
    approvalRequired: connector.approvalRequired || riskLevel >= 2,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function inferToolRisk(defaultRisk: ToolRiskLevel, annotations?: Record<string, unknown>): ToolRiskLevel {
  if (annotations?.destructiveHint || annotations?.openWorldHint) {
    return 2;
  }

  if (annotations?.readOnlyHint) {
    return 0;
  }

  if (annotations?.idempotentHint && defaultRisk > 1) {
    return 1;
  }

  return defaultRisk;
}

function toPlainObject(value: unknown): Record<string, unknown> | undefined {
  const json = toJsonValue(value);
  if (json && typeof json === "object" && !Array.isArray(json)) {
    return json as Record<string, unknown>;
  }

  return undefined;
}

function toJsonValue<T>(value: T): T | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}
