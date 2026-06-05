import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
import type {
  McpConnectorAuthType,
  McpConnectorLedger,
  McpConnectorRecord,
  McpConnectorStats,
  McpConnectorTransport,
  McpToolRecord,
} from "@/lib/connectors/types";
import type { ToolRiskLevel } from "@/lib/tools/types";

let connectorFileWriteQueue: Promise<void> = Promise.resolve();

export type RegisterMcpConnectorInput = {
  name: string;
  endpoint: string;
  transport?: McpConnectorTransport;
  authType?: McpConnectorAuthType;
  authTokenEnv?: string;
  defaultRiskLevel?: ToolRiskLevel;
  approvalRequired?: boolean;
};

export function createMcpConnectorRecord(input: RegisterMcpConnectorInput): McpConnectorRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: input.name.trim(),
    endpoint: input.endpoint.trim(),
    transport: input.transport || "streamable_http",
    authType: input.authType || "none",
    authTokenEnv: input.authTokenEnv?.trim() || undefined,
    status: "active",
    defaultRiskLevel: input.defaultRiskLevel ?? 2,
    approvalRequired: input.approvalRequired ?? true,
    toolCount: 0,
    capabilities: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function createMcpToolId(connectorId: string, toolName: string) {
  return `mcp:${connectorId}:${encodeURIComponent(toolName)}`;
}

export function parseMcpToolId(toolId: string) {
  const [prefix, connectorId, encodedToolName] = toolId.split(":");
  if (prefix !== "mcp" || !connectorId || !encodedToolName) {
    return null;
  }

  return {
    connectorId,
    toolName: decodeURIComponent(encodedToolName),
  };
}

export async function saveMcpConnector(connector: McpConnectorRecord) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_mcp_connectors (
        id, name, endpoint, transport, auth_type, auth_token_env, status,
        default_risk_level, approval_required, tool_count, capabilities,
        instructions, server_version, last_discovered_at, last_error,
        created_at, updated_at
      )
      VALUES (
        ${connector.id}, ${connector.name}, ${connector.endpoint}, ${connector.transport},
        ${connector.authType}, ${connector.authTokenEnv || null}, ${connector.status},
        ${connector.defaultRiskLevel}, ${connector.approvalRequired}, ${connector.toolCount},
        ${JSON.stringify(connector.capabilities || {})}::jsonb, ${connector.instructions || null},
        ${JSON.stringify(connector.serverVersion || null)}::jsonb,
        ${connector.lastDiscoveredAt || null}, ${connector.lastError || null},
        ${connector.createdAt}, ${connector.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        endpoint = EXCLUDED.endpoint,
        transport = EXCLUDED.transport,
        auth_type = EXCLUDED.auth_type,
        auth_token_env = EXCLUDED.auth_token_env,
        status = EXCLUDED.status,
        default_risk_level = EXCLUDED.default_risk_level,
        approval_required = EXCLUDED.approval_required,
        tool_count = EXCLUDED.tool_count,
        capabilities = EXCLUDED.capabilities,
        instructions = EXCLUDED.instructions,
        server_version = EXCLUDED.server_version,
        last_discovered_at = EXCLUDED.last_discovered_at,
        last_error = EXCLUDED.last_error,
        updated_at = EXCLUDED.updated_at
    `;
    return connector;
  }

  await mutateConnectorLedger((ledger) => {
    ledger.connectors = [connector, ...ledger.connectors.filter((item) => item.id !== connector.id)];
    return ledger;
  });
  return connector;
}

export async function listMcpConnectors(limit = 20) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_mcp_connectors
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(connectorFromRow);
  }

  const ledger = await readConnectorLedger();
  return ledger.connectors.slice(0, limit);
}

export async function getMcpConnector(connectorId: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_mcp_connectors
      WHERE id = ${connectorId}
      LIMIT 1
    `;
    return rows[0] ? connectorFromRow(rows[0]) : null;
  }

  const ledger = await readConnectorLedger();
  return ledger.connectors.find((connector) => connector.id === connectorId) || null;
}

export async function saveMcpDiscovery({
  connector,
  tools,
  capabilities,
  instructions,
  serverVersion,
}: {
  connector: McpConnectorRecord;
  tools: McpToolRecord[];
  capabilities?: Record<string, unknown>;
  instructions?: string;
  serverVersion?: Record<string, unknown>;
}) {
  const discoveredAt = new Date().toISOString();
  const nextConnector: McpConnectorRecord = {
    ...connector,
    status: "active",
    toolCount: tools.length,
    capabilities: capabilities || {},
    instructions,
    serverVersion,
    lastDiscoveredAt: discoveredAt,
    lastError: undefined,
    updatedAt: discoveredAt,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await saveMcpConnector(nextConnector);
    await getSql()`DELETE FROM omni_mcp_tools WHERE connector_id = ${connector.id}`;
    for (const tool of tools) {
      await saveMcpTool({ ...tool, connectorName: nextConnector.name });
    }
    return { connector: nextConnector, tools };
  }

  await mutateConnectorLedger((ledger) => {
    ledger.connectors = [nextConnector, ...ledger.connectors.filter((item) => item.id !== connector.id)];
    ledger.tools = [
      ...tools.map((tool) => ({ ...tool, connectorName: nextConnector.name })),
      ...ledger.tools.filter((tool) => tool.connectorId !== connector.id),
    ];
    return ledger;
  });
  return { connector: nextConnector, tools };
}

export async function saveMcpTool(tool: McpToolRecord) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_mcp_tools (
        id, connector_id, connector_name, name, title, description,
        input_schema, output_schema, annotations, risk_level,
        approval_required, status, created_at, updated_at
      )
      VALUES (
        ${tool.id}, ${tool.connectorId}, ${tool.connectorName}, ${tool.name},
        ${tool.title || null}, ${tool.description || null},
        ${JSON.stringify(tool.inputSchema || {})}::jsonb,
        ${JSON.stringify(tool.outputSchema || null)}::jsonb,
        ${JSON.stringify(tool.annotations || null)}::jsonb,
        ${tool.riskLevel}, ${tool.approvalRequired}, ${tool.status},
        ${tool.createdAt}, ${tool.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        connector_name = EXCLUDED.connector_name,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        input_schema = EXCLUDED.input_schema,
        output_schema = EXCLUDED.output_schema,
        annotations = EXCLUDED.annotations,
        risk_level = EXCLUDED.risk_level,
        approval_required = EXCLUDED.approval_required,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at
    `;
    return tool;
  }

  await mutateConnectorLedger((ledger) => {
    ledger.tools = [tool, ...ledger.tools.filter((item) => item.id !== tool.id)];
    return ledger;
  });
  return tool;
}

export async function listMcpTools(connectorId?: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = connectorId
      ? await getSql()`
          SELECT *
          FROM omni_mcp_tools
          WHERE connector_id = ${connectorId}
          ORDER BY updated_at DESC
        `
      : await getSql()`
          SELECT *
          FROM omni_mcp_tools
          ORDER BY updated_at DESC
        `;
    return rows.map(toolFromRow);
  }

  const ledger = await readConnectorLedger();
  return ledger.tools.filter((tool) => !connectorId || tool.connectorId === connectorId);
}

export async function getMcpToolById(toolId: string) {
  const parsed = parseMcpToolId(toolId);
  if (!parsed) {
    return null;
  }

  const tools = await listMcpTools(parsed.connectorId);
  return tools.find((tool) => tool.name === parsed.toolName) || null;
}

export async function recordMcpConnectorError(connector: McpConnectorRecord, error: string) {
  const now = new Date().toISOString();
  return saveMcpConnector({
    ...connector,
    status: "error",
    lastError: error,
    updatedAt: now,
  });
}

export async function getMcpConnectorStats(): Promise<McpConnectorStats> {
  const connectors = await listMcpConnectors(100);
  const tools = await listMcpTools();
  return {
    total: connectors.length,
    active: connectors.filter((connector) => connector.status === "active").length,
    error: connectors.filter((connector) => connector.status === "error").length,
    toolCount: tools.filter((tool) => tool.status === "active").length,
    latest: connectors.slice(0, 5),
  };
}

async function readConnectorLedger() {
  return readJsonFile<McpConnectorLedger>(getConnectorLedgerFile(), { connectors: [], tools: [] });
}

async function mutateConnectorLedger(mutator: (ledger: McpConnectorLedger) => McpConnectorLedger) {
  connectorFileWriteQueue = connectorFileWriteQueue.then(
    async () => {
      const ledger = mutator(await readConnectorLedger());
      await writeConnectorLedger(ledger);
    },
    async () => {
      const ledger = mutator(await readConnectorLedger());
      await writeConnectorLedger(ledger);
    },
  );
  await connectorFileWriteQueue;
}

async function writeConnectorLedger(ledger: McpConnectorLedger) {
  await writeJsonFile(getConnectorLedgerFile(), {
    connectors: ledger.connectors.slice(0, 100),
    tools: ledger.tools.slice(0, 500),
  });
}

function getConnectorLedgerFile() {
  return getDataPath("mcp-connectors.json");
}

function connectorFromRow(row: Record<string, unknown>): McpConnectorRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    endpoint: String(row.endpoint),
    transport: String(row.transport) as McpConnectorTransport,
    authType: String(row.auth_type) as McpConnectorAuthType,
    authTokenEnv: row.auth_token_env ? String(row.auth_token_env) : undefined,
    status: String(row.status) as McpConnectorRecord["status"],
    defaultRiskLevel: Number(row.default_risk_level) as ToolRiskLevel,
    approvalRequired: Boolean(row.approval_required),
    toolCount: Number(row.tool_count || 0),
    capabilities: parseObject(row.capabilities),
    instructions: row.instructions ? String(row.instructions) : undefined,
    serverVersion: parseObject(row.server_version),
    lastDiscoveredAt: row.last_discovered_at ? normalizeDate(row.last_discovered_at) : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function toolFromRow(row: Record<string, unknown>): McpToolRecord {
  return {
    id: String(row.id),
    connectorId: String(row.connector_id),
    connectorName: String(row.connector_name),
    name: String(row.name),
    title: row.title ? String(row.title) : undefined,
    description: row.description ? String(row.description) : undefined,
    inputSchema: parseObject(row.input_schema) || { type: "object" },
    outputSchema: parseObject(row.output_schema),
    annotations: parseObject(row.annotations),
    riskLevel: Number(row.risk_level) as ToolRiskLevel,
    approvalRequired: Boolean(row.approval_required),
    status: String(row.status) as McpToolRecord["status"],
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}
