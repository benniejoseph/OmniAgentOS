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
  tenantId?: string;
  name: string;
  endpoint: string;
  transport?: McpConnectorTransport;
  authType?: McpConnectorAuthType;
  authTokenEnv?: string;
  defaultRiskLevel?: ToolRiskLevel;
  approvalRequired?: boolean;
};

type TenantScopedOptions = {
  tenantId?: string;
};

export function createMcpConnectorRecord(input: RegisterMcpConnectorInput): McpConnectorRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    tenantId: normalizeTenantId(input.tenantId),
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
  const record = {
    ...connector,
    tenantId: normalizeTenantId(connector.tenantId),
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_mcp_connectors (
        id, tenant_id, name, endpoint, transport, auth_type, auth_token_env, status,
        default_risk_level, approval_required, tool_count, capabilities,
        instructions, server_version, last_discovered_at, last_error,
        created_at, updated_at
      )
      VALUES (
        ${record.id}, ${record.tenantId}, ${record.name}, ${record.endpoint}, ${record.transport},
        ${record.authType}, ${record.authTokenEnv || null}, ${record.status},
        ${record.defaultRiskLevel}, ${record.approvalRequired}, ${record.toolCount},
        ${JSON.stringify(record.capabilities || {})}::jsonb, ${record.instructions || null},
        ${JSON.stringify(record.serverVersion || null)}::jsonb,
        ${record.lastDiscoveredAt || null}, ${record.lastError || null},
        ${record.createdAt}, ${record.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
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
    return record;
  }

  await mutateConnectorLedger((ledger) => {
    ledger.connectors = [record, ...ledger.connectors.filter((item) => item.id !== record.id)];
    return ledger;
  });
  return record;
}

export async function listMcpConnectors(limit = 20, options: TenantScopedOptions = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_mcp_connectors
      WHERE tenant_id = ${tenantId}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(connectorFromRow);
  }

  const ledger = await readConnectorLedger();
  return ledger.connectors
    .filter((connector) => normalizeTenantId(connector.tenantId) === tenantId)
    .slice(0, limit);
}

export async function getMcpConnector(connectorId: string, options: TenantScopedOptions = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_mcp_connectors
      WHERE id = ${connectorId}
        AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    return rows[0] ? connectorFromRow(rows[0]) : null;
  }

  const ledger = await readConnectorLedger();
  return ledger.connectors.find(
    (connector) => connector.id === connectorId && normalizeTenantId(connector.tenantId) === tenantId,
  ) || null;
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
    tenantId: normalizeTenantId(connector.tenantId),
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
    await getSql()`
      DELETE FROM omni_mcp_tools
      WHERE connector_id = ${connector.id}
        AND tenant_id = ${nextConnector.tenantId}
    `;
    const nextTools = tools.map((tool) => ({
      ...tool,
      tenantId: nextConnector.tenantId,
      connectorName: nextConnector.name,
    }));
    for (const tool of tools) {
      await saveMcpTool({ ...tool, tenantId: nextConnector.tenantId, connectorName: nextConnector.name });
    }
    return { connector: nextConnector, tools: nextTools };
  }

  const nextTools = tools.map((tool) => ({ ...tool, tenantId: nextConnector.tenantId, connectorName: nextConnector.name }));
  await mutateConnectorLedger((ledger) => {
    ledger.connectors = [nextConnector, ...ledger.connectors.filter((item) => item.id !== connector.id)];
    ledger.tools = [
      ...nextTools,
      ...ledger.tools.filter((tool) =>
        tool.connectorId !== connector.id || normalizeTenantId(tool.tenantId) !== nextConnector.tenantId,
      ),
    ];
    return ledger;
  });
  return { connector: nextConnector, tools: nextTools };
}

export async function saveMcpTool(tool: McpToolRecord) {
  const record = {
    ...tool,
    tenantId: normalizeTenantId(tool.tenantId),
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_mcp_tools (
        id, tenant_id, connector_id, connector_name, name, title, description,
        input_schema, output_schema, annotations, risk_level,
        approval_required, status, created_at, updated_at
      )
      VALUES (
        ${record.id}, ${record.tenantId}, ${record.connectorId}, ${record.connectorName}, ${record.name},
        ${record.title || null}, ${record.description || null},
        ${JSON.stringify(record.inputSchema || {})}::jsonb,
        ${JSON.stringify(record.outputSchema || null)}::jsonb,
        ${JSON.stringify(record.annotations || null)}::jsonb,
        ${record.riskLevel}, ${record.approvalRequired}, ${record.status},
        ${record.createdAt}, ${record.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
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
    return record;
  }

  await mutateConnectorLedger((ledger) => {
    ledger.tools = [record, ...ledger.tools.filter((item) => item.id !== record.id)];
    return ledger;
  });
  return record;
}

export async function listMcpTools(connectorId?: string, options: TenantScopedOptions = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = connectorId
      ? await getSql()`
          SELECT *
          FROM omni_mcp_tools
          WHERE connector_id = ${connectorId}
            AND tenant_id = ${tenantId}
          ORDER BY updated_at DESC
        `
      : await getSql()`
          SELECT *
          FROM omni_mcp_tools
          WHERE tenant_id = ${tenantId}
          ORDER BY updated_at DESC
        `;
    return rows.map(toolFromRow);
  }

  const ledger = await readConnectorLedger();
  return ledger.tools.filter(
    (tool) => (!connectorId || tool.connectorId === connectorId) && normalizeTenantId(tool.tenantId) === tenantId,
  );
}

export async function getMcpToolById(toolId: string, options: TenantScopedOptions = {}) {
  const parsed = parseMcpToolId(toolId);
  if (!parsed) {
    return null;
  }

  const tools = await listMcpTools(parsed.connectorId, options);
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

export async function getMcpConnectorStats(options: TenantScopedOptions = {}): Promise<McpConnectorStats> {
  const connectors = await listMcpConnectors(100, options);
  const tools = await listMcpTools(undefined, options);
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
    tenantId: String(row.tenant_id || "default"),
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
    tenantId: String(row.tenant_id || "default"),
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

function normalizeTenantId(value?: string) {
  return (value || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}
