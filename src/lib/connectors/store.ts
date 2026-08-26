import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  ConnectorContractReviewConflictError,
  mcpContractReviewSummary,
  mcpToolContractFingerprint,
} from "@/lib/connectors/contract-review";
import { recordRuntimeEventSafely } from "@/lib/observability/store";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import type {
  McpConnectorAuthType,
  McpConnectorLedger,
  McpConnectorRecord,
  McpConnectorStats,
  McpConnectorTransport,
  McpToolRecord,
} from "@/lib/connectors/types";
import type { ToolRiskLevel } from "@/lib/tools/types";

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

export type UpdateMcpConnectorInput = Partial<Pick<
  RegisterMcpConnectorInput,
  "name" | "endpoint" | "authType" | "authTokenEnv" | "defaultRiskLevel" | "approvalRequired"
>> & {
  status?: McpConnectorRecord["status"];
};

export type McpContractPromotionResult = {
  connector: McpConnectorRecord;
  tools: McpToolRecord[];
  promoted: number;
};

type TenantScopedOptions = {
  tenantId?: string;
};

export type McpToolMetadataRecord = Pick<
  McpToolRecord,
  | "id"
  | "connectorId"
  | "connectorName"
  | "name"
  | "title"
  | "description"
  | "riskLevel"
  | "approvalRequired"
>;

export type McpToolMetadataSearchOptions = TenantScopedOptions & {
  query?: string;
  limit?: number;
  allowlist?: readonly string[];
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
        ${record.capabilities || {}}::jsonb, ${record.instructions || null},
        ${record.serverVersion || null}::jsonb,
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

export async function listMcpConnectorsRequiringReview(
  options: TenantScopedOptions = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT connectors.*
      FROM omni_mcp_connectors connectors
      WHERE connectors.tenant_id = ${tenantId}
        AND EXISTS (
          SELECT 1
          FROM omni_mcp_tools tools
          WHERE tools.connector_id = connectors.id
            AND tools.tenant_id = connectors.tenant_id
            AND tools.status = 'pending_review'
        )
      ORDER BY connectors.updated_at DESC
    `;
    return rows.map(connectorFromRow);
  }

  const ledger = await readConnectorLedger();
  const pendingConnectorIds = new Set(
    ledger.tools
      .filter(
        (tool) =>
          normalizeTenantId(tool.tenantId) === tenantId &&
          tool.status === "pending_review",
      )
      .map((tool) => tool.connectorId),
  );
  return ledger.connectors.filter(
    (connector) =>
      normalizeTenantId(connector.tenantId) === tenantId &&
      pendingConnectorIds.has(connector.id),
  );
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

export async function updateMcpConnector(
  connectorId: string,
  input: UpdateMcpConnectorInput,
  options: TenantScopedOptions = {},
) {
  const connector = await getMcpConnector(connectorId, options);
  if (!connector) {
    return null;
  }

  const now = new Date().toISOString();
  const contractConfigurationChanged =
    (input.endpoint !== undefined && input.endpoint.trim() !== connector.endpoint) ||
    (input.authType !== undefined && input.authType !== connector.authType) ||
    (input.authTokenEnv !== undefined &&
      (input.authTokenEnv?.trim() || undefined) !== connector.authTokenEnv);
  const nextConnector: McpConnectorRecord = {
    ...connector,
    name: input.name?.trim() || connector.name,
    endpoint: input.endpoint?.trim() || connector.endpoint,
    authType: input.authType || connector.authType,
    authTokenEnv: input.authTokenEnv === undefined ? connector.authTokenEnv : input.authTokenEnv?.trim() || undefined,
    status: contractConfigurationChanged
      ? "disabled"
      : input.status || connector.status,
    defaultRiskLevel: input.defaultRiskLevel ?? connector.defaultRiskLevel,
    approvalRequired: input.approvalRequired ?? connector.approvalRequired,
    lastDiscoveredAt: contractConfigurationChanged
      ? undefined
      : connector.lastDiscoveredAt,
    lastError: input.status === "active" && !contractConfigurationChanged
      ? undefined
      : connector.lastError,
    updatedAt: now,
  };
  const saved = await saveMcpConnector(nextConnector);
  await syncMcpToolsForConnector(saved, {
    invalidateReviewedContracts: contractConfigurationChanged,
  });
  return saved;
}

export async function deleteMcpConnector(connectorId: string, options: TenantScopedOptions = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const connector = await getMcpConnector(connectorId, { tenantId });
  if (!connector) {
    return null;
  }

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      DELETE FROM omni_mcp_tools
      WHERE connector_id = ${connectorId}
        AND tenant_id = ${tenantId}
    `;
    await getSql()`
      DELETE FROM omni_mcp_connectors
      WHERE id = ${connectorId}
        AND tenant_id = ${tenantId}
    `;
    return connector;
  }

  await mutateConnectorLedger((ledger) => {
    ledger.connectors = ledger.connectors.filter(
      (item) => item.id !== connectorId || normalizeTenantId(item.tenantId) !== tenantId,
    );
    ledger.tools = ledger.tools.filter(
      (tool) => tool.connectorId !== connectorId || normalizeTenantId(tool.tenantId) !== tenantId,
    );
    return ledger;
  });
  return connector;
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
  const existingTools = await listMcpTools(connector.id, {
    tenantId: normalizeTenantId(connector.tenantId),
  });
  const nextConnector: McpConnectorRecord = {
    ...connector,
    tenantId: normalizeTenantId(connector.tenantId),
    status: connector.status === "error" ? "active" : connector.status,
    toolCount: tools.length,
    capabilities: capabilities || {},
    instructions,
    serverVersion,
    lastDiscoveredAt: discoveredAt,
    lastError: undefined,
    updatedAt: discoveredAt,
  };
  const nextTools = preserveReviewedMcpToolPolicy({
    discovered: tools,
    existing: existingTools,
    connector: nextConnector,
    reviewedConnector: connector,
  });

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await saveMcpConnector(nextConnector);
    await getSql()`
      DELETE FROM omni_mcp_tools
      WHERE connector_id = ${connector.id}
        AND tenant_id = ${nextConnector.tenantId}
    `;
    for (const tool of nextTools) {
      await saveMcpTool(tool);
    }
    return { connector: nextConnector, tools: nextTools };
  }

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

export function preserveReviewedMcpToolPolicy({
  discovered,
  existing,
  connector,
  reviewedConnector = connector,
}: {
  discovered: McpToolRecord[];
  existing: McpToolRecord[];
  connector: McpConnectorRecord;
  reviewedConnector?: McpConnectorRecord;
}) {
  const reviewedByName = new Map(existing.map((tool) => [tool.name, tool]));
  return discovered.map((tool) => {
    const reviewed = reviewedByName.get(tool.name);
    return {
      ...tool,
      tenantId: normalizeTenantId(connector.tenantId),
      connectorName: connector.name,
      riskLevel: Math.max(tool.riskLevel, reviewed?.riskLevel ?? 0) as ToolRiskLevel,
      approvalRequired: tool.approvalRequired || Boolean(reviewed?.approvalRequired),
      status:
        reviewed &&
        mcpToolContractFingerprint(reviewed, reviewedConnector) ===
          mcpToolContractFingerprint(tool, connector)
          ? reviewed.status
          : "pending_review",
      createdAt: reviewed?.createdAt || tool.createdAt,
    };
  });
}

export async function promoteMcpContracts(
  {
    connectorId,
    expectedFingerprint,
  }: {
    connectorId: string;
    expectedFingerprint: string;
  },
  options: TenantScopedOptions = {},
): Promise<McpContractPromotionResult | null> {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const connectorRows = await sql`
        SELECT *
        FROM omni_mcp_connectors
        WHERE id = ${connectorId}
          AND tenant_id = ${tenantId}
        FOR UPDATE
      `;
      if (!connectorRows[0]) {
        return null;
      }
      const connector = connectorFromRow(connectorRows[0]);
      const toolRows = await sql`
        SELECT *
        FROM omni_mcp_tools
        WHERE connector_id = ${connectorId}
          AND tenant_id = ${tenantId}
        ORDER BY id
        FOR UPDATE
      `;
      const tools = toolRows.map(toolFromRow);
      const review = mcpContractReviewSummary(tools, connector);
      if (!review.pendingCount) {
        return { connector, tools, promoted: 0 };
      }
      if (review.fingerprint !== expectedFingerprint) {
        throw new ConnectorContractReviewConflictError();
      }
      await sql`
        UPDATE omni_mcp_tools
        SET status = 'active',
            updated_at = NOW()
        WHERE connector_id = ${connectorId}
          AND tenant_id = ${tenantId}
          AND status = 'pending_review'
      `;
      const activatedRows = await sql`
        UPDATE omni_mcp_connectors
        SET status = 'active',
            error = NULL,
            updated_at = NOW()
        WHERE id = ${connectorId}
          AND tenant_id = ${tenantId}
        RETURNING *
      `;
      const activatedConnector = activatedRows[0]
        ? connectorFromRow(activatedRows[0])
        : { ...connector, status: "active" as const };
      return {
        connector: activatedConnector,
        tools: tools.map((tool) =>
          tool.status === "pending_review"
            ? { ...tool, status: "active" as const }
            : tool,
        ),
        promoted: review.pendingCount,
      };
    }) as Promise<McpContractPromotionResult | null>;
  }

  let result: McpContractPromotionResult | null = null;
  await mutateConnectorLedger((ledger) => {
    const connector = ledger.connectors.find(
      (item) =>
        item.id === connectorId &&
        normalizeTenantId(item.tenantId) === tenantId,
    );
    if (!connector) {
      result = null;
      return ledger;
    }
    const tools = ledger.tools.filter(
      (tool) =>
        tool.connectorId === connectorId &&
        normalizeTenantId(tool.tenantId) === tenantId,
    );
    const review = mcpContractReviewSummary(tools, connector);
    if (review.pendingCount && review.fingerprint !== expectedFingerprint) {
      throw new ConnectorContractReviewConflictError();
    }
    ledger.tools = ledger.tools.map((tool) =>
      tool.connectorId === connectorId &&
      normalizeTenantId(tool.tenantId) === tenantId &&
      tool.status === "pending_review"
        ? { ...tool, status: "active", updatedAt: new Date().toISOString() }
        : tool,
    );
    const activatedConnector = {
      ...connector,
      status: "active" as const,
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
    ledger.connectors = ledger.connectors.map((item) =>
      item.id === connector.id ? activatedConnector : item,
    );
    result = {
      connector: activatedConnector,
      tools: ledger.tools.filter(
        (tool) =>
          tool.connectorId === connectorId &&
          normalizeTenantId(tool.tenantId) === tenantId,
      ),
      promoted: review.pendingCount,
    };
    return ledger;
  });
  return result;
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
        ${record.inputSchema || {}}::jsonb,
        ${record.outputSchema || null}::jsonb,
        ${record.annotations || null}::jsonb,
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

async function syncMcpToolsForConnector(
  connector: McpConnectorRecord,
  options: { invalidateReviewedContracts?: boolean } = {},
) {
  const tenantId = normalizeTenantId(connector.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      UPDATE omni_mcp_tools
      SET connector_name = ${connector.name},
          status = CASE
            WHEN ${Boolean(options.invalidateReviewedContracts)}
              AND status = 'active'
              THEN 'pending_review'
            ELSE status
          END,
          updated_at = ${connector.updatedAt}
      WHERE connector_id = ${connector.id}
        AND tenant_id = ${tenantId}
    `;
    return;
  }

  await mutateConnectorLedger((ledger) => {
    ledger.tools = ledger.tools.map((tool) =>
      tool.connectorId === connector.id && normalizeTenantId(tool.tenantId) === tenantId
        ? {
            ...tool,
            connectorName: connector.name,
            status:
              options.invalidateReviewedContracts && tool.status === "active"
                ? "pending_review"
                : tool.status,
            updatedAt: connector.updatedAt,
          }
        : tool,
    );
    return ledger;
  });
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

/**
 * Searches the active catalog without selecting connector schemas, annotations,
 * endpoints, or secret bindings. Full contracts are loaded only after selection.
 */
export async function searchActiveMcpToolMetadata(
  options: McpToolMetadataSearchOptions = {},
): Promise<McpToolMetadataRecord[]> {
  const tenantId = normalizeTenantId(options.tenantId);
  const limit = normalizeMetadataLimit(options.limit);
  const allowlist = normalizeMetadataAllowlist(options.allowlist);
  const terms = normalizeMetadataSearchTerms(options.query);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const patterns = terms.map((term) => `%${term}%`);
    const rows = await getSql()`
      SELECT
        tools.id,
        tools.connector_id,
        tools.connector_name,
        tools.name,
        tools.title,
        tools.description,
        tools.risk_level,
        tools.approval_required
      FROM omni_mcp_tools tools
      INNER JOIN omni_mcp_connectors connectors
        ON connectors.id = tools.connector_id
        AND connectors.tenant_id = tools.tenant_id
      WHERE tools.tenant_id = ${tenantId}
        AND tools.status = 'active'
        AND connectors.status = 'active'
        AND (${allowlist === undefined} OR tools.id = ANY(${allowlist || []}::text[]))
        AND (
          ${patterns.length === 0}
          OR LOWER(CONCAT_WS(' ', tools.id, tools.connector_name, tools.name, tools.title, tools.description))
            LIKE ANY(${patterns}::text[])
        )
      ORDER BY
        (
          SELECT COUNT(*)
          FROM unnest(${patterns}::text[]) AS matched(pattern)
          WHERE LOWER(CONCAT_WS(
            ' ', tools.id, tools.connector_name, tools.name, tools.title, tools.description
          )) LIKE matched.pattern
        ) DESC,
        tools.updated_at DESC,
        tools.id ASC
      LIMIT ${limit}
    `;
    return rows.map(mcpToolMetadataFromRow);
  }

  const ledger = await readConnectorLedger();
  const activeConnectorIds = new Set(
    ledger.connectors
      .filter(
        (connector) =>
          normalizeTenantId(connector.tenantId) === tenantId &&
          connector.status === "active",
      )
      .map((connector) => connector.id),
  );
  const allowed = allowlist === undefined ? undefined : new Set(allowlist);
  return ledger.tools
    .filter(
      (tool) =>
        normalizeTenantId(tool.tenantId) === tenantId &&
        tool.status === "active" &&
        activeConnectorIds.has(tool.connectorId) &&
        (!allowed || allowed.has(tool.id)) &&
        metadataMatchesTerms(
          `${tool.id} ${tool.connectorName} ${tool.name} ${tool.title || ""} ${tool.description || ""}`,
          terms,
        ),
    )
    .sort(
      (left, right) =>
        metadataTermScore(
          `${right.id} ${right.connectorName} ${right.name} ${right.title || ""} ${right.description || ""}`,
          terms,
        ) - metadataTermScore(
          `${left.id} ${left.connectorName} ${left.name} ${left.title || ""} ${left.description || ""}`,
          terms,
        ) || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    )
    .slice(0, limit)
    .map(toMcpToolMetadata);
}

export async function getMcpToolById(toolId: string, options: TenantScopedOptions = {}) {
  const parsed = parseMcpToolId(toolId);
  if (!parsed) {
    return null;
  }

  const tenantId = normalizeTenantId(options.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_mcp_tools
      WHERE id = ${toolId}
        AND connector_id = ${parsed.connectorId}
        AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    return rows[0] ? toolFromRow(rows[0]) : null;
  }

  const ledger = await readConnectorLedger();
  return ledger.tools.find(
    (tool) =>
      tool.id === toolId &&
      tool.connectorId === parsed.connectorId &&
      tool.name === parsed.toolName &&
      normalizeTenantId(tool.tenantId) === tenantId,
  ) || null;
}

export async function recordMcpConnectorError(connector: McpConnectorRecord, error: string) {
  const now = new Date().toISOString();
  const saved = await saveMcpConnector({
    ...connector,
    status: "error",
    lastError: error,
    updatedAt: now,
  });
  await syncMcpToolsForConnector(saved);
  await recordRuntimeEventSafely({
    level: "error",
    category: "connector",
    action: "connector.mcp.discovery_failed",
    tenantId: saved.tenantId,
    resourceType: "mcp_connector",
    resourceId: saved.id,
    message: error,
    metadata: {
      failureType: "connector_failure",
      connectorName: saved.name,
      connectorStatus: saved.status,
    },
  });
  return saved;
}

export async function getMcpConnectorStats(options: TenantScopedOptions = {}): Promise<McpConnectorStats> {
  const connectors = await listMcpConnectors(100, options);
  const tools = await listMcpTools(undefined, options);
  const activeConnectorIds = new Set(
    connectors
      .filter((connector) => connector.status === "active")
      .map((connector) => connector.id),
  );
  return {
    total: connectors.length,
    active: connectors.filter((connector) => connector.status === "active").length,
    error: connectors.filter((connector) => connector.status === "error").length,
    toolCount: tools.filter(
      (tool) =>
        tool.status === "active" && activeConnectorIds.has(tool.connectorId),
    ).length,
    latest: connectors.slice(0, 5),
  };
}

async function readConnectorLedger() {
  return readJsonFile<McpConnectorLedger>(getConnectorLedgerFile(), { connectors: [], tools: [] });
}

async function mutateConnectorLedger(mutator: (ledger: McpConnectorLedger) => McpConnectorLedger) {
  await updateJsonFile<McpConnectorLedger>(
    getConnectorLedgerFile(),
    { connectors: [], tools: [] },
    (ledger) => {
      const next = mutator(ledger);
      return {
        connectors: next.connectors.slice(0, 100),
        tools: next.tools.slice(0, 500),
      };
    },
  );
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

function mcpToolMetadataFromRow(row: Record<string, unknown>): McpToolMetadataRecord {
  return {
    id: String(row.id),
    connectorId: String(row.connector_id),
    connectorName: String(row.connector_name),
    name: String(row.name),
    title: row.title ? String(row.title) : undefined,
    description: row.description ? String(row.description) : undefined,
    riskLevel: Number(row.risk_level) as ToolRiskLevel,
    approvalRequired: Boolean(row.approval_required),
  };
}

function toMcpToolMetadata(tool: McpToolRecord): McpToolMetadataRecord {
  return {
    id: tool.id,
    connectorId: tool.connectorId,
    connectorName: tool.connectorName,
    name: tool.name,
    title: tool.title,
    description: tool.description,
    riskLevel: tool.riskLevel,
    approvalRequired: tool.approvalRequired,
  };
}

function normalizeMetadataLimit(value?: number) {
  return Number.isFinite(value)
    ? Math.min(Math.max(Math.floor(value as number), 1), 200)
    : 100;
}

function normalizeMetadataAllowlist(value?: readonly string[]) {
  if (value === undefined) {
    return undefined;
  }
  return [...new Set(value.map((id) => id.trim()).filter(Boolean))].slice(0, 128);
}

function normalizeMetadataSearchTerms(value?: string) {
  return [...new Set(
    (value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [],
  )].filter((term) =>
    !METADATA_SEARCH_STOP_WORDS.has(term) &&
    (term.length >= 3 || METADATA_SEARCH_SHORT_TERMS.has(term))
  ).slice(0, 12);
}

function metadataMatchesTerms(value: string, terms: readonly string[]) {
  if (!terms.length) {
    return true;
  }
  const normalized = value.normalize("NFKD").toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function metadataTermScore(value: string, terms: readonly string[]) {
  const normalized = value.normalize("NFKD").toLowerCase();
  return terms.reduce(
    (score, term) => score + (normalized.includes(term) ? 1 : 0),
    0,
  );
}

const METADATA_SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "can", "could", "for", "from", "get", "i", "in",
  "is", "it", "me", "my", "of", "on", "or", "please", "the", "this", "to",
  "use", "want", "with", "you",
]);
const METADATA_SEARCH_SHORT_TERMS = new Set(["ai", "db", "hr", "qa"]);

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
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}
