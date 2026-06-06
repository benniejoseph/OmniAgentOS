import { createHash, randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import type {
  OpenApiConnectorAuthType,
  OpenApiConnectorLedger,
  OpenApiConnectorRecord,
  OpenApiConnectorStats,
  OpenApiOperationRecord,
} from "@/lib/connectors/openapi-types";
import type { ToolRiskLevel } from "@/lib/tools/types";

let openApiFileWriteQueue: Promise<void> = Promise.resolve();

export type RegisterOpenApiConnectorInput = {
  name: string;
  specUrl?: string;
  specHash?: string;
  baseUrl: string;
  authType?: OpenApiConnectorAuthType;
  authTokenEnv?: string;
  authHeaderName?: string;
  defaultRiskLevel?: ToolRiskLevel;
  approvalRequired?: boolean;
  info?: Record<string, unknown>;
};

export function createOpenApiConnectorRecord(input: RegisterOpenApiConnectorInput): OpenApiConnectorRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: input.name.trim(),
    specUrl: input.specUrl?.trim() || undefined,
    specHash: input.specHash,
    baseUrl: input.baseUrl.trim(),
    authType: input.authType || "none",
    authTokenEnv: input.authTokenEnv?.trim() || undefined,
    authHeaderName: input.authHeaderName?.trim() || undefined,
    status: "active",
    defaultRiskLevel: input.defaultRiskLevel ?? 2,
    approvalRequired: input.approvalRequired ?? true,
    operationCount: 0,
    info: input.info || {},
    createdAt: now,
    updatedAt: now,
  };
}

export function createOpenApiToolId(connectorId: string, operationId: string) {
  return `openapi:${connectorId}:${encodeURIComponent(operationId)}`;
}

export function parseOpenApiToolId(toolId: string) {
  const [prefix, connectorId, encodedOperationId] = toolId.split(":");
  if (prefix !== "openapi" || !connectorId || !encodedOperationId) {
    return null;
  }

  return {
    connectorId,
    operationId: decodeURIComponent(encodedOperationId),
  };
}

export function hashOpenApiSpec(specText: string) {
  return createHash("sha256").update(specText).digest("hex");
}

export async function saveOpenApiConnector(connector: OpenApiConnectorRecord) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_openapi_connectors (
        id, name, spec_url, spec_hash, base_url, auth_type, auth_token_env,
        auth_header_name, status, default_risk_level, approval_required,
        operation_count, info, last_imported_at, last_error, created_at, updated_at
      )
      VALUES (
        ${connector.id}, ${connector.name}, ${connector.specUrl || null},
        ${connector.specHash || null}, ${connector.baseUrl}, ${connector.authType},
        ${connector.authTokenEnv || null}, ${connector.authHeaderName || null},
        ${connector.status}, ${connector.defaultRiskLevel}, ${connector.approvalRequired},
        ${connector.operationCount}, ${JSON.stringify(connector.info || {})}::jsonb,
        ${connector.lastImportedAt || null}, ${connector.lastError || null},
        ${connector.createdAt}, ${connector.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        spec_url = EXCLUDED.spec_url,
        spec_hash = EXCLUDED.spec_hash,
        base_url = EXCLUDED.base_url,
        auth_type = EXCLUDED.auth_type,
        auth_token_env = EXCLUDED.auth_token_env,
        auth_header_name = EXCLUDED.auth_header_name,
        status = EXCLUDED.status,
        default_risk_level = EXCLUDED.default_risk_level,
        approval_required = EXCLUDED.approval_required,
        operation_count = EXCLUDED.operation_count,
        info = EXCLUDED.info,
        last_imported_at = EXCLUDED.last_imported_at,
        last_error = EXCLUDED.last_error,
        updated_at = EXCLUDED.updated_at
    `;
    return connector;
  }

  await mutateOpenApiLedger((ledger) => {
    ledger.connectors = [connector, ...ledger.connectors.filter((item) => item.id !== connector.id)];
    return ledger;
  });
  return connector;
}

export async function listOpenApiConnectors(limit = 20) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_openapi_connectors
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(openApiConnectorFromRow);
  }

  const ledger = await readOpenApiLedger();
  return ledger.connectors.slice(0, limit);
}

export async function getOpenApiConnector(connectorId: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_openapi_connectors
      WHERE id = ${connectorId}
      LIMIT 1
    `;
    return rows[0] ? openApiConnectorFromRow(rows[0]) : null;
  }

  const ledger = await readOpenApiLedger();
  return ledger.connectors.find((connector) => connector.id === connectorId) || null;
}

export async function saveOpenApiImport({
  connector,
  operations,
  specHash,
  baseUrl,
  info,
}: {
  connector: OpenApiConnectorRecord;
  operations: OpenApiOperationRecord[];
  specHash?: string;
  baseUrl?: string;
  info?: Record<string, unknown>;
}) {
  const importedAt = new Date().toISOString();
  const nextConnector: OpenApiConnectorRecord = {
    ...connector,
    status: "active",
    specHash: specHash || connector.specHash,
    baseUrl: baseUrl || connector.baseUrl,
    operationCount: operations.length,
    info: info || connector.info || {},
    lastImportedAt: importedAt,
    lastError: undefined,
    updatedAt: importedAt,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await saveOpenApiConnector(nextConnector);
    await getSql()`DELETE FROM omni_openapi_operations WHERE connector_id = ${connector.id}`;
    for (const operation of operations) {
      await saveOpenApiOperation({ ...operation, connectorName: nextConnector.name });
    }
    return { connector: nextConnector, operations };
  }

  await mutateOpenApiLedger((ledger) => {
    ledger.connectors = [nextConnector, ...ledger.connectors.filter((item) => item.id !== connector.id)];
    ledger.operations = [
      ...operations.map((operation) => ({ ...operation, connectorName: nextConnector.name })),
      ...ledger.operations.filter((operation) => operation.connectorId !== connector.id),
    ];
    return ledger;
  });
  return { connector: nextConnector, operations };
}

export async function saveOpenApiOperation(operation: OpenApiOperationRecord) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_openapi_operations (
        id, connector_id, connector_name, operation_id, method, path, summary,
        description, input_schema, request_content_type, response_content_types,
        risk_level, approval_required, status, created_at, updated_at
      )
      VALUES (
        ${operation.id}, ${operation.connectorId}, ${operation.connectorName},
        ${operation.operationId}, ${operation.method}, ${operation.path},
        ${operation.summary || null}, ${operation.description || null},
        ${JSON.stringify(operation.inputSchema || {})}::jsonb,
        ${operation.requestContentType || null}, ${operation.responseContentTypes},
        ${operation.riskLevel}, ${operation.approvalRequired}, ${operation.status},
        ${operation.createdAt}, ${operation.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        connector_name = EXCLUDED.connector_name,
        method = EXCLUDED.method,
        path = EXCLUDED.path,
        summary = EXCLUDED.summary,
        description = EXCLUDED.description,
        input_schema = EXCLUDED.input_schema,
        request_content_type = EXCLUDED.request_content_type,
        response_content_types = EXCLUDED.response_content_types,
        risk_level = EXCLUDED.risk_level,
        approval_required = EXCLUDED.approval_required,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at
    `;
    return operation;
  }

  await mutateOpenApiLedger((ledger) => {
    ledger.operations = [operation, ...ledger.operations.filter((item) => item.id !== operation.id)];
    return ledger;
  });
  return operation;
}

export async function listOpenApiOperations(connectorId?: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = connectorId
      ? await getSql()`
          SELECT *
          FROM omni_openapi_operations
          WHERE connector_id = ${connectorId}
          ORDER BY updated_at DESC
        `
      : await getSql()`
          SELECT *
          FROM omni_openapi_operations
          ORDER BY updated_at DESC
        `;
    return rows.map(openApiOperationFromRow);
  }

  const ledger = await readOpenApiLedger();
  return ledger.operations.filter((operation) => !connectorId || operation.connectorId === connectorId);
}

export async function getOpenApiOperationById(toolId: string) {
  const parsed = parseOpenApiToolId(toolId);
  if (!parsed) {
    return null;
  }

  const operations = await listOpenApiOperations(parsed.connectorId);
  return operations.find((operation) => operation.operationId === parsed.operationId) || null;
}

export async function recordOpenApiConnectorError(connector: OpenApiConnectorRecord, error: string) {
  const now = new Date().toISOString();
  return saveOpenApiConnector({
    ...connector,
    status: "error",
    lastError: error,
    updatedAt: now,
  });
}

export async function getOpenApiConnectorStats(): Promise<OpenApiConnectorStats> {
  const connectors = await listOpenApiConnectors(100);
  const operations = await listOpenApiOperations();
  return {
    total: connectors.length,
    active: connectors.filter((connector) => connector.status === "active").length,
    error: connectors.filter((connector) => connector.status === "error").length,
    operationCount: operations.filter((operation) => operation.status === "active").length,
    latest: connectors.slice(0, 5),
  };
}

async function readOpenApiLedger() {
  return readJsonFile<OpenApiConnectorLedger>(getOpenApiLedgerFile(), { connectors: [], operations: [] });
}

async function mutateOpenApiLedger(mutator: (ledger: OpenApiConnectorLedger) => OpenApiConnectorLedger) {
  openApiFileWriteQueue = openApiFileWriteQueue.then(
    async () => {
      const ledger = mutator(await readOpenApiLedger());
      await writeOpenApiLedger(ledger);
    },
    async () => {
      const ledger = mutator(await readOpenApiLedger());
      await writeOpenApiLedger(ledger);
    },
  );
  await openApiFileWriteQueue;
}

async function writeOpenApiLedger(ledger: OpenApiConnectorLedger) {
  await writeJsonFile(getOpenApiLedgerFile(), {
    connectors: ledger.connectors.slice(0, 100),
    operations: ledger.operations.slice(0, 1000),
  });
}

function getOpenApiLedgerFile() {
  return getDataPath("openapi-connectors.json");
}

function openApiConnectorFromRow(row: Record<string, unknown>): OpenApiConnectorRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    specUrl: row.spec_url ? String(row.spec_url) : undefined,
    specHash: row.spec_hash ? String(row.spec_hash) : undefined,
    baseUrl: String(row.base_url),
    authType: String(row.auth_type) as OpenApiConnectorAuthType,
    authTokenEnv: row.auth_token_env ? String(row.auth_token_env) : undefined,
    authHeaderName: row.auth_header_name ? String(row.auth_header_name) : undefined,
    status: String(row.status) as OpenApiConnectorRecord["status"],
    defaultRiskLevel: Number(row.default_risk_level) as ToolRiskLevel,
    approvalRequired: Boolean(row.approval_required),
    operationCount: Number(row.operation_count || 0),
    info: parseObject(row.info),
    lastImportedAt: row.last_imported_at ? normalizeDate(row.last_imported_at) : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function openApiOperationFromRow(row: Record<string, unknown>): OpenApiOperationRecord {
  return {
    id: String(row.id),
    connectorId: String(row.connector_id),
    connectorName: String(row.connector_name),
    operationId: String(row.operation_id),
    method: String(row.method) as OpenApiOperationRecord["method"],
    path: String(row.path),
    summary: row.summary ? String(row.summary) : undefined,
    description: row.description ? String(row.description) : undefined,
    inputSchema: parseObject(row.input_schema) || { type: "object" },
    requestContentType: row.request_content_type ? String(row.request_content_type) : undefined,
    responseContentTypes: Array.isArray(row.response_content_types)
      ? row.response_content_types.map(String)
      : [],
    riskLevel: Number(row.risk_level) as ToolRiskLevel,
    approvalRequired: Boolean(row.approval_required),
    status: String(row.status) as OpenApiOperationRecord["status"],
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
