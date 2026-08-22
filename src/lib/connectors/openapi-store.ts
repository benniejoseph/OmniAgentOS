import { createHash, randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  ConnectorContractReviewConflictError,
  openApiContractReviewSummary,
  openApiOperationContractFingerprint,
} from "@/lib/connectors/contract-review";
import { recordRuntimeEventSafely } from "@/lib/observability/store";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import type {
  OpenApiConnectorAuthType,
  OpenApiConnectorLedger,
  OpenApiConnectorRecord,
  OpenApiConnectorStats,
  OpenApiOperationRecord,
} from "@/lib/connectors/openapi-types";
import type { ToolRiskLevel } from "@/lib/tools/types";

export type RegisterOpenApiConnectorInput = {
  tenantId?: string;
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

export type UpdateOpenApiConnectorInput = Partial<Pick<
  RegisterOpenApiConnectorInput,
  | "name"
  | "specUrl"
  | "baseUrl"
  | "authType"
  | "authTokenEnv"
  | "authHeaderName"
  | "defaultRiskLevel"
  | "approvalRequired"
>> & {
  status?: OpenApiConnectorRecord["status"];
};

export type OpenApiContractPromotionResult = {
  connector: OpenApiConnectorRecord;
  operations: OpenApiOperationRecord[];
  promoted: number;
};

type TenantScopedOptions = {
  tenantId?: string;
};

export function createOpenApiConnectorRecord(input: RegisterOpenApiConnectorInput): OpenApiConnectorRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    tenantId: normalizeTenantId(input.tenantId),
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
  const record = {
    ...connector,
    tenantId: normalizeTenantId(connector.tenantId),
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_openapi_connectors (
        id, tenant_id, name, spec_url, spec_hash, base_url, auth_type, auth_token_env,
        auth_header_name, status, default_risk_level, approval_required,
        operation_count, info, last_imported_at, last_error, created_at, updated_at
      )
      VALUES (
        ${record.id}, ${record.tenantId}, ${record.name}, ${record.specUrl || null},
        ${record.specHash || null}, ${record.baseUrl}, ${record.authType},
        ${record.authTokenEnv || null}, ${record.authHeaderName || null},
        ${record.status}, ${record.defaultRiskLevel}, ${record.approvalRequired},
        ${record.operationCount}, ${JSON.stringify(record.info || {})}::jsonb,
        ${record.lastImportedAt || null}, ${record.lastError || null},
        ${record.createdAt}, ${record.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
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
    return record;
  }

  await mutateOpenApiLedger((ledger) => {
    ledger.connectors = [record, ...ledger.connectors.filter((item) => item.id !== record.id)];
    return ledger;
  });
  return record;
}

export async function listOpenApiConnectors(limit = 20, options: TenantScopedOptions = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_openapi_connectors
      WHERE tenant_id = ${tenantId}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(openApiConnectorFromRow);
  }

  const ledger = await readOpenApiLedger();
  return ledger.connectors
    .filter((connector) => normalizeTenantId(connector.tenantId) === tenantId)
    .slice(0, limit);
}

export async function listOpenApiConnectorsRequiringReview(
  options: TenantScopedOptions = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT connectors.*
      FROM omni_openapi_connectors connectors
      WHERE connectors.tenant_id = ${tenantId}
        AND EXISTS (
          SELECT 1
          FROM omni_openapi_operations operations
          WHERE operations.connector_id = connectors.id
            AND operations.tenant_id = connectors.tenant_id
            AND operations.status = 'pending_review'
        )
      ORDER BY connectors.updated_at DESC
    `;
    return rows.map(openApiConnectorFromRow);
  }

  const ledger = await readOpenApiLedger();
  const pendingConnectorIds = new Set(
    ledger.operations
      .filter(
        (operation) =>
          normalizeTenantId(operation.tenantId) === tenantId &&
          operation.status === "pending_review",
      )
      .map((operation) => operation.connectorId),
  );
  return ledger.connectors.filter(
    (connector) =>
      normalizeTenantId(connector.tenantId) === tenantId &&
      pendingConnectorIds.has(connector.id),
  );
}

export async function getOpenApiConnector(connectorId: string, options: TenantScopedOptions = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_openapi_connectors
      WHERE id = ${connectorId}
        AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    return rows[0] ? openApiConnectorFromRow(rows[0]) : null;
  }

  const ledger = await readOpenApiLedger();
  return ledger.connectors.find(
    (connector) => connector.id === connectorId && normalizeTenantId(connector.tenantId) === tenantId,
  ) || null;
}

export async function updateOpenApiConnector(
  connectorId: string,
  input: UpdateOpenApiConnectorInput,
  options: TenantScopedOptions = {},
) {
  const connector = await getOpenApiConnector(connectorId, options);
  if (!connector) {
    return null;
  }

  const now = new Date().toISOString();
  const contractConfigurationChanged =
    (input.specUrl !== undefined &&
      (input.specUrl?.trim() || undefined) !== connector.specUrl) ||
    (input.baseUrl !== undefined && input.baseUrl.trim() !== connector.baseUrl) ||
    (input.authType !== undefined && input.authType !== connector.authType) ||
    (input.authTokenEnv !== undefined &&
      (input.authTokenEnv?.trim() || undefined) !== connector.authTokenEnv) ||
    (input.authHeaderName !== undefined &&
      (input.authHeaderName?.trim() || undefined) !== connector.authHeaderName);
  const nextConnector: OpenApiConnectorRecord = {
    ...connector,
    name: input.name?.trim() || connector.name,
    specUrl: input.specUrl === undefined ? connector.specUrl : input.specUrl?.trim() || undefined,
    baseUrl: input.baseUrl?.trim() || connector.baseUrl,
    authType: input.authType || connector.authType,
    authTokenEnv: input.authTokenEnv === undefined ? connector.authTokenEnv : input.authTokenEnv?.trim() || undefined,
    authHeaderName:
      input.authHeaderName === undefined ? connector.authHeaderName : input.authHeaderName?.trim() || undefined,
    status: contractConfigurationChanged
      ? "disabled"
      : input.status || connector.status,
    defaultRiskLevel: input.defaultRiskLevel ?? connector.defaultRiskLevel,
    approvalRequired: input.approvalRequired ?? connector.approvalRequired,
    lastImportedAt: contractConfigurationChanged
      ? undefined
      : connector.lastImportedAt,
    lastError: input.status === "active" && !contractConfigurationChanged
      ? undefined
      : connector.lastError,
    updatedAt: now,
  };
  const saved = await saveOpenApiConnector(nextConnector);
  await syncOpenApiOperationsForConnector(saved, {
    invalidateReviewedContracts: contractConfigurationChanged,
  });
  return saved;
}

export async function deleteOpenApiConnector(connectorId: string, options: TenantScopedOptions = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const connector = await getOpenApiConnector(connectorId, { tenantId });
  if (!connector) {
    return null;
  }

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      DELETE FROM omni_openapi_operations
      WHERE connector_id = ${connectorId}
        AND tenant_id = ${tenantId}
    `;
    await getSql()`
      DELETE FROM omni_openapi_connectors
      WHERE id = ${connectorId}
        AND tenant_id = ${tenantId}
    `;
    return connector;
  }

  await mutateOpenApiLedger((ledger) => {
    ledger.connectors = ledger.connectors.filter(
      (item) => item.id !== connectorId || normalizeTenantId(item.tenantId) !== tenantId,
    );
    ledger.operations = ledger.operations.filter(
      (operation) => operation.connectorId !== connectorId || normalizeTenantId(operation.tenantId) !== tenantId,
    );
    return ledger;
  });
  return connector;
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
  const existingOperations = await listOpenApiOperations(connector.id, {
    tenantId: normalizeTenantId(connector.tenantId),
  });
  const candidateConnector: OpenApiConnectorRecord = {
    ...connector,
    tenantId: normalizeTenantId(connector.tenantId),
    specHash: specHash || connector.specHash,
    baseUrl: baseUrl || connector.baseUrl,
    operationCount: operations.length,
    info: info || connector.info || {},
    lastImportedAt: importedAt,
    lastError: undefined,
    updatedAt: importedAt,
  };
  const nextConnector: OpenApiConnectorRecord = {
    ...candidateConnector,
    status: connector.status === "error" ? "active" : connector.status,
  };
  const nextOperations = preserveReviewedOperationPolicy({
    discovered: operations,
    existing: existingOperations,
    connector: nextConnector,
    reviewedConnector: connector,
  });

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await saveOpenApiConnector(nextConnector);
    await getSql()`
      DELETE FROM omni_openapi_operations
      WHERE connector_id = ${connector.id}
        AND tenant_id = ${nextConnector.tenantId}
    `;
    for (const operation of nextOperations) {
      await saveOpenApiOperation(operation);
    }
    return { connector: nextConnector, operations: nextOperations };
  }

  await mutateOpenApiLedger((ledger) => {
    ledger.connectors = [nextConnector, ...ledger.connectors.filter((item) => item.id !== connector.id)];
    ledger.operations = [
      ...nextOperations,
      ...ledger.operations.filter((operation) =>
        operation.connectorId !== connector.id || normalizeTenantId(operation.tenantId) !== nextConnector.tenantId,
      ),
    ];
    return ledger;
  });
  return { connector: nextConnector, operations: nextOperations };
}

export function preserveReviewedOperationPolicy({
  discovered,
  existing,
  connector,
  reviewedConnector = connector,
}: {
  discovered: OpenApiOperationRecord[];
  existing: OpenApiOperationRecord[];
  connector: OpenApiConnectorRecord;
  reviewedConnector?: OpenApiConnectorRecord;
}) {
  const reviewedByOperationId = new Map(existing.map((operation) => [operation.operationId, operation]));
  return discovered.map((operation) => {
    const reviewed = reviewedByOperationId.get(operation.operationId);
    return {
      ...operation,
      tenantId: normalizeTenantId(connector.tenantId),
      connectorName: connector.name,
      riskLevel: Math.max(operation.riskLevel, reviewed?.riskLevel ?? 0) as ToolRiskLevel,
      approvalRequired: operation.approvalRequired || Boolean(reviewed?.approvalRequired),
      status:
        reviewed &&
        openApiOperationContractFingerprint(reviewed, reviewedConnector) ===
          openApiOperationContractFingerprint(operation, connector)
          ? reviewed.status
          : "pending_review",
      createdAt: reviewed?.createdAt || operation.createdAt,
    };
  });
}

export async function promoteOpenApiContracts(
  {
    connectorId,
    expectedFingerprint,
  }: {
    connectorId: string;
    expectedFingerprint: string;
  },
  options: TenantScopedOptions = {},
): Promise<OpenApiContractPromotionResult | null> {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const connectorRows = await sql`
        SELECT *
        FROM omni_openapi_connectors
        WHERE id = ${connectorId}
          AND tenant_id = ${tenantId}
        FOR UPDATE
      `;
      if (!connectorRows[0]) {
        return null;
      }
      const connector = openApiConnectorFromRow(connectorRows[0]);
      const operationRows = await sql`
        SELECT *
        FROM omni_openapi_operations
        WHERE connector_id = ${connectorId}
          AND tenant_id = ${tenantId}
        ORDER BY id
        FOR UPDATE
      `;
      const operations = operationRows.map(openApiOperationFromRow);
      const review = openApiContractReviewSummary(operations, connector);
      if (!review.pendingCount) {
        return { connector, operations, promoted: 0 };
      }
      if (review.fingerprint !== expectedFingerprint) {
        throw new ConnectorContractReviewConflictError();
      }
      await sql`
        UPDATE omni_openapi_operations
        SET status = 'active',
            updated_at = NOW()
        WHERE connector_id = ${connectorId}
          AND tenant_id = ${tenantId}
          AND status = 'pending_review'
      `;
      const activatedRows = await sql`
        UPDATE omni_openapi_connectors
        SET status = 'active',
            error = NULL,
            updated_at = NOW()
        WHERE id = ${connectorId}
          AND tenant_id = ${tenantId}
        RETURNING *
      `;
      const activatedConnector = activatedRows[0]
        ? openApiConnectorFromRow(activatedRows[0])
        : { ...connector, status: "active" as const };
      return {
        connector: activatedConnector,
        operations: operations.map((operation) =>
          operation.status === "pending_review"
            ? { ...operation, status: "active" as const }
            : operation,
        ),
        promoted: review.pendingCount,
      };
    }) as Promise<OpenApiContractPromotionResult | null>;
  }

  let result: OpenApiContractPromotionResult | null = null;
  await mutateOpenApiLedger((ledger) => {
    const connector = ledger.connectors.find(
      (item) =>
        item.id === connectorId &&
        normalizeTenantId(item.tenantId) === tenantId,
    );
    if (!connector) {
      result = null;
      return ledger;
    }
    const operations = ledger.operations.filter(
      (operation) =>
        operation.connectorId === connectorId &&
        normalizeTenantId(operation.tenantId) === tenantId,
    );
    const review = openApiContractReviewSummary(operations, connector);
    if (review.pendingCount && review.fingerprint !== expectedFingerprint) {
      throw new ConnectorContractReviewConflictError();
    }
    ledger.operations = ledger.operations.map((operation) =>
      operation.connectorId === connectorId &&
      normalizeTenantId(operation.tenantId) === tenantId &&
      operation.status === "pending_review"
        ? {
            ...operation,
            status: "active",
            updatedAt: new Date().toISOString(),
          }
        : operation,
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
      operations: ledger.operations.filter(
        (operation) =>
          operation.connectorId === connectorId &&
          normalizeTenantId(operation.tenantId) === tenantId,
      ),
      promoted: review.pendingCount,
    };
    return ledger;
  });
  return result;
}

export async function saveOpenApiOperation(operation: OpenApiOperationRecord) {
  const record = {
    ...operation,
    tenantId: normalizeTenantId(operation.tenantId),
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_openapi_operations (
        id, tenant_id, connector_id, connector_name, operation_id, method, path, summary,
        description, input_schema, request_content_type, response_content_types,
        risk_level, approval_required, status, created_at, updated_at
      )
      VALUES (
        ${record.id}, ${record.tenantId}, ${record.connectorId}, ${record.connectorName},
        ${record.operationId}, ${record.method}, ${record.path},
        ${record.summary || null}, ${record.description || null},
        ${JSON.stringify(record.inputSchema || {})}::jsonb,
        ${record.requestContentType || null}, ${record.responseContentTypes},
        ${record.riskLevel}, ${record.approvalRequired}, ${record.status},
        ${record.createdAt}, ${record.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
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
    return record;
  }

  await mutateOpenApiLedger((ledger) => {
    ledger.operations = [record, ...ledger.operations.filter((item) => item.id !== record.id)];
    return ledger;
  });
  return record;
}

async function syncOpenApiOperationsForConnector(
  connector: OpenApiConnectorRecord,
  options: { invalidateReviewedContracts?: boolean } = {},
) {
  const tenantId = normalizeTenantId(connector.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      UPDATE omni_openapi_operations
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

  await mutateOpenApiLedger((ledger) => {
    ledger.operations = ledger.operations.map((operation) =>
      operation.connectorId === connector.id && normalizeTenantId(operation.tenantId) === tenantId
        ? {
            ...operation,
            connectorName: connector.name,
            status:
              options.invalidateReviewedContracts &&
              operation.status === "active"
                ? "pending_review"
                : operation.status,
            updatedAt: connector.updatedAt,
          }
        : operation,
    );
    return ledger;
  });
}

export async function listOpenApiOperations(connectorId?: string, options: TenantScopedOptions = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = connectorId
      ? await getSql()`
          SELECT *
          FROM omni_openapi_operations
          WHERE connector_id = ${connectorId}
            AND tenant_id = ${tenantId}
          ORDER BY updated_at DESC
        `
      : await getSql()`
          SELECT *
          FROM omni_openapi_operations
          WHERE tenant_id = ${tenantId}
          ORDER BY updated_at DESC
        `;
    return rows.map(openApiOperationFromRow);
  }

  const ledger = await readOpenApiLedger();
  return ledger.operations.filter(
    (operation) =>
      (!connectorId || operation.connectorId === connectorId) &&
      normalizeTenantId(operation.tenantId) === tenantId,
  );
}

export async function getOpenApiOperationById(toolId: string, options: TenantScopedOptions = {}) {
  const parsed = parseOpenApiToolId(toolId);
  if (!parsed) {
    return null;
  }

  const operations = await listOpenApiOperations(parsed.connectorId, options);
  return operations.find((operation) => operation.operationId === parsed.operationId) || null;
}

export async function recordOpenApiConnectorError(connector: OpenApiConnectorRecord, error: string) {
  const now = new Date().toISOString();
  const saved = await saveOpenApiConnector({
    ...connector,
    status: "error",
    lastError: error,
    updatedAt: now,
  });
  await syncOpenApiOperationsForConnector(saved);
  await recordRuntimeEventSafely({
    level: "error",
    category: "connector",
    action: "connector.openapi.import_failed",
    tenantId: saved.tenantId,
    resourceType: "openapi_connector",
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

export async function getOpenApiConnectorStats(options: TenantScopedOptions = {}): Promise<OpenApiConnectorStats> {
  const connectors = await listOpenApiConnectors(100, options);
  const operations = await listOpenApiOperations(undefined, options);
  const activeConnectorIds = new Set(
    connectors
      .filter((connector) => connector.status === "active")
      .map((connector) => connector.id),
  );
  return {
    total: connectors.length,
    active: connectors.filter((connector) => connector.status === "active").length,
    error: connectors.filter((connector) => connector.status === "error").length,
    operationCount: operations.filter(
      (operation) =>
        operation.status === "active" &&
        activeConnectorIds.has(operation.connectorId),
    ).length,
    latest: connectors.slice(0, 5),
  };
}

async function readOpenApiLedger() {
  return readJsonFile<OpenApiConnectorLedger>(getOpenApiLedgerFile(), { connectors: [], operations: [] });
}

async function mutateOpenApiLedger(mutator: (ledger: OpenApiConnectorLedger) => OpenApiConnectorLedger) {
  await updateJsonFile<OpenApiConnectorLedger>(
    getOpenApiLedgerFile(),
    { connectors: [], operations: [] },
    (ledger) => {
      const next = mutator(ledger);
      return {
        connectors: next.connectors.slice(0, 100),
        operations: next.operations.slice(0, 1000),
      };
    },
  );
}

function getOpenApiLedgerFile() {
  return getDataPath("openapi-connectors.json");
}

function openApiConnectorFromRow(row: Record<string, unknown>): OpenApiConnectorRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
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
    tenantId: String(row.tenant_id || "default"),
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

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}
