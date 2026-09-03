import { createHash } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  assertExecutionScopeTenant,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import {
  openCredentialBundle,
  sealCredentialBundle,
  type SealedCredentialPayload,
} from "@/lib/settings/credential-vault";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import type {
  McpConnectorCredentialMetadata,
  McpConnectorLedger,
  McpConnectorRecord,
} from "@/lib/connectors/types";

const MCP_CREDENTIAL_BINDING_PREFIX = "omniagent:mcp-bearer:v1";
const MCP_CREDENTIAL_FIELD = "bearerToken";
const MCP_CREDENTIAL_MAX_BYTES = 8_192;

type InternalMcpCredential = {
  connectorId: string;
  tenantId: string;
  origin?: string;
  version: number;
  keyId?: string;
  fingerprint?: string;
  sealedCredential?: SealedCredentialPayload;
  createdBy: string;
  rotatedBy: string;
  createdAt: string;
  rotatedAt: string;
};

type InternalMcpConnectorLedger = McpConnectorLedger & {
  credentials?: InternalMcpCredential[];
};

type StoredCredentialFields = {
  version?: unknown;
  keyId?: unknown;
  fingerprint?: unknown;
  origin?: unknown;
  sealedCredential?: unknown;
  rotatedAt?: unknown;
};

export class McpCredentialStoreError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "McpCredentialStoreError";
  }
}

export async function storeMcpBearerCredential(input: {
  tenantId: string;
  connectorId: string;
  endpoint: string;
  bearerToken: string;
  executionScope: ExecutionScope;
}) {
  const executionScope = requireCredentialMutationScope(
    input.executionScope,
    input.tenantId,
  );
  const actorId = requireCredentialActor(executionScope);
  validateBearerToken(input.bearerToken);
  const expectedOrigin = mcpCredentialEndpointOrigin(input.endpoint);

  const result = await runWithDatabaseTenantScope(input.tenantId, async () => {
    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
        const rows = await sql`
          SELECT id, endpoint, credential_version, credential_created_by,
                 credential_created_at, sealed_credential
          FROM omni_mcp_connectors
          WHERE id = ${input.connectorId}
            AND tenant_id = ${input.tenantId}
          FOR UPDATE
        `;
        const row = rows[0];
        if (!row) {
          throw new McpCredentialStoreError("MCP connector not found.", 404);
        }
        if (mcpCredentialEndpointOrigin(String(row.endpoint)) !== expectedOrigin) {
          throw new McpCredentialStoreError(
            "The MCP connector endpoint changed before its credential could be saved.",
            409,
          );
        }

        const existingVersion = positiveInteger(row.credential_version) || 0;
        const credentialVersion = existingVersion + 1;
        const now = new Date().toISOString();
        const sealedCredential = sealCredentialBundle(
          { [MCP_CREDENTIAL_FIELD]: input.bearerToken },
          mcpCredentialBinding({
            tenantId: input.tenantId,
            connectorId: input.connectorId,
            origin: expectedOrigin,
            credentialVersion,
          }),
        );
        const fingerprint = mcpBearerFingerprint(input.bearerToken);

        await sql`
          UPDATE omni_mcp_connectors
          SET auth_type = 'bearer_vault',
              auth_token_env = NULL,
              credential_version = ${credentialVersion},
              credential_key_id = ${sealedCredential.keyId},
              credential_fingerprint = ${fingerprint},
              credential_origin = ${expectedOrigin},
              sealed_credential = ${sealedCredential}::jsonb,
              credential_created_by = COALESCE(credential_created_by, ${actorId}),
              credential_rotated_by = ${actorId},
              credential_created_at = COALESCE(credential_created_at, ${now}),
              credential_rotated_at = ${now},
              status = 'disabled',
              tool_count = 0,
              capabilities = '{}'::jsonb,
              instructions = NULL,
              server_version = NULL,
              last_discovered_at = NULL,
              last_error = NULL,
              updated_at = ${now}
          WHERE id = ${input.connectorId}
            AND tenant_id = ${input.tenantId}
        `;
        await sql`
          DELETE FROM omni_mcp_tools
          WHERE connector_id = ${input.connectorId}
            AND tenant_id = ${input.tenantId}
        `;

        return {
          credential: credentialMetadata({
            version: credentialVersion,
            keyId: sealedCredential.keyId,
            fingerprint,
            origin: expectedOrigin,
            sealedCredential,
            rotatedAt: now,
          }, input.endpoint),
          rotated: Boolean(row.credential_created_by),
        };
      }) as Promise<{
        credential: McpConnectorCredentialMetadata;
        rotated: boolean;
      }>;
    }

    let saved: {
      credential: McpConnectorCredentialMetadata;
      rotated: boolean;
    } | undefined;
    await updateJsonFile<InternalMcpConnectorLedger>(
      connectorLedgerFile(),
      emptyConnectorLedger(),
      (ledger) => {
        const connectorIndex = ledger.connectors.findIndex(
          (item) => item.id === input.connectorId && sameTenant(item.tenantId, input.tenantId),
        );
        if (connectorIndex < 0) {
          throw new McpCredentialStoreError("MCP connector not found.", 404);
        }
        const connector = ledger.connectors[connectorIndex];
        if (mcpCredentialEndpointOrigin(connector.endpoint) !== expectedOrigin) {
          throw new McpCredentialStoreError(
            "The MCP connector endpoint changed before its credential could be saved.",
            409,
          );
        }
        const credentials = ledger.credentials || [];
        const existing = credentials.find(
          (item) => item.connectorId === input.connectorId && sameTenant(item.tenantId, input.tenantId),
        );
        const credentialVersion = Math.max(
          existing?.version || 0,
          connector.credentialVersion || 0,
        ) + 1;
        const now = new Date().toISOString();
        const sealedCredential = sealCredentialBundle(
          { [MCP_CREDENTIAL_FIELD]: input.bearerToken },
          mcpCredentialBinding({
            tenantId: input.tenantId,
            connectorId: input.connectorId,
            origin: expectedOrigin,
            credentialVersion,
          }),
        );
        const record: InternalMcpCredential = {
          connectorId: input.connectorId,
          tenantId: input.tenantId,
          origin: expectedOrigin,
          version: credentialVersion,
          keyId: sealedCredential.keyId,
          fingerprint: mcpBearerFingerprint(input.bearerToken),
          sealedCredential,
          createdBy: existing?.createdBy || actorId,
          rotatedBy: actorId,
          createdAt: existing?.createdAt || now,
          rotatedAt: now,
        };
        const metadata = credentialMetadata(record, connector.endpoint);
        ledger.credentials = [
          record,
          ...credentials.filter((item) => !(
            item.connectorId === input.connectorId && sameTenant(item.tenantId, input.tenantId)
          )),
        ];
        ledger.connectors[connectorIndex] = {
          ...connector,
          authType: "bearer_vault",
          authTokenEnv: undefined,
          ...connectorCredentialFields(metadata),
          status: "disabled",
          toolCount: 0,
          capabilities: {},
          instructions: undefined,
          serverVersion: undefined,
          lastDiscoveredAt: undefined,
          lastError: undefined,
          updatedAt: now,
        };
        ledger.tools = ledger.tools.filter(
          (tool) => !(
            tool.connectorId === input.connectorId && sameTenant(tool.tenantId, input.tenantId)
          ),
        );
        saved = {
          credential: metadata,
          rotated: Boolean(existing || connector.credentialVersion),
        };
        return ledger;
      },
    );
    if (!saved) {
      throw new McpCredentialStoreError("MCP connector credential could not be saved.", 409);
    }
    return saved;
  });

  await credentialEvent({
    connectorId: input.connectorId,
    type: result.rotated
      ? "connector.mcp.credential_rotated"
      : "connector.mcp.credential_saved",
    executionScope,
    credentialAction: result.rotated ? "rotated" : "saved",
    credentialVersion: result.credential.version,
    credentialFingerprint: result.credential.fingerprint,
    credentialOrigin: expectedOrigin,
  });
  return result;
}

export async function removeMcpBearerCredential(input: {
  tenantId: string;
  connectorId: string;
  executionScope: ExecutionScope;
}) {
  const executionScope = requireCredentialMutationScope(
    input.executionScope,
    input.tenantId,
  );
  const actorId = requireCredentialActor(executionScope);

  const result = await runWithDatabaseTenantScope(input.tenantId, async () => {
    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
        const rows = await sql`
          SELECT id, endpoint, auth_type, credential_version,
                 credential_key_id, credential_fingerprint,
                 credential_origin, sealed_credential
          FROM omni_mcp_connectors
          WHERE id = ${input.connectorId}
            AND tenant_id = ${input.tenantId}
          FOR UPDATE
        `;
        const row = rows[0];
        if (!row) {
          throw new McpCredentialStoreError("MCP connector not found.", 404);
        }
        const wasConfigured = isStoredCredentialConfigured({
          version: row.credential_version,
          keyId: row.credential_key_id,
          fingerprint: row.credential_fingerprint,
          origin: row.credential_origin,
          sealedCredential: row.sealed_credential,
        });
        if (!wasConfigured && String(row.auth_type) !== "bearer_vault") {
          throw new McpCredentialStoreError(
            "This MCP connector does not use an app-managed bearer credential.",
            409,
          );
        }
        const currentVersion = positiveInteger(row.credential_version);
        const credentialVersion = wasConfigured
          ? (currentVersion || 0) + 1
          : currentVersion;
        const now = new Date().toISOString();
        await sql`
          UPDATE omni_mcp_connectors
          SET credential_version = ${credentialVersion || null},
              credential_key_id = NULL,
              credential_fingerprint = NULL,
              credential_origin = NULL,
              sealed_credential = NULL,
              credential_rotated_by = ${actorId},
              credential_rotated_at = ${now},
              status = 'disabled',
              tool_count = 0,
              capabilities = '{}'::jsonb,
              instructions = NULL,
              server_version = NULL,
              last_discovered_at = NULL,
              last_error = NULL,
              updated_at = ${now}
          WHERE id = ${input.connectorId}
            AND tenant_id = ${input.tenantId}
        `;
        await sql`
          DELETE FROM omni_mcp_tools
          WHERE connector_id = ${input.connectorId}
            AND tenant_id = ${input.tenantId}
        `;
        return {
          credential: {
            configured: false,
            version: credentialVersion,
            rotatedAt: now,
            originMatch: false,
          } satisfies McpConnectorCredentialMetadata,
          removed: wasConfigured,
        };
      }) as Promise<{
        credential: McpConnectorCredentialMetadata;
        removed: boolean;
      }>;
    }

    let removed: {
      credential: McpConnectorCredentialMetadata;
      removed: boolean;
    } | undefined;
    await updateJsonFile<InternalMcpConnectorLedger>(
      connectorLedgerFile(),
      emptyConnectorLedger(),
      (ledger) => {
        const connectorIndex = ledger.connectors.findIndex(
          (item) => item.id === input.connectorId && sameTenant(item.tenantId, input.tenantId),
        );
        if (connectorIndex < 0) {
          throw new McpCredentialStoreError("MCP connector not found.", 404);
        }
        const connector = ledger.connectors[connectorIndex];
        const credentials = ledger.credentials || [];
        const existing = credentials.find(
          (item) => item.connectorId === input.connectorId && sameTenant(item.tenantId, input.tenantId),
        );
        if (!existing && connector.authType !== "bearer_vault") {
          throw new McpCredentialStoreError(
            "This MCP connector does not use an app-managed bearer credential.",
            409,
          );
        }
        const now = new Date().toISOString();
        const wasConfigured = Boolean(existing && isStoredCredentialConfigured(existing));
        const credentialVersion = wasConfigured
          ? existing!.version + 1
          : existing?.version || connector.credentialVersion || 1;
        const metadata: McpConnectorCredentialMetadata = {
          configured: false,
          version: credentialVersion,
          rotatedAt: now,
          originMatch: false,
        };
        ledger.credentials = [
          {
            connectorId: input.connectorId,
            tenantId: input.tenantId,
            version: credentialVersion || 1,
            createdBy: existing?.createdBy || actorId,
            rotatedBy: actorId,
            createdAt: existing?.createdAt || now,
            rotatedAt: now,
          },
          ...credentials.filter((item) => !(
            item.connectorId === input.connectorId && sameTenant(item.tenantId, input.tenantId)
          )),
        ];
        ledger.connectors[connectorIndex] = {
          ...connector,
          ...connectorCredentialFields(metadata),
          status: "disabled",
          toolCount: 0,
          capabilities: {},
          instructions: undefined,
          serverVersion: undefined,
          lastDiscoveredAt: undefined,
          lastError: undefined,
          updatedAt: now,
        };
        ledger.tools = ledger.tools.filter(
          (tool) => !(
            tool.connectorId === input.connectorId && sameTenant(tool.tenantId, input.tenantId)
          ),
        );
        removed = { credential: metadata, removed: wasConfigured };
        return ledger;
      },
    );
    if (!removed) {
      throw new McpCredentialStoreError("MCP connector credential could not be removed.", 409);
    }
    return removed;
  });

  await credentialEvent({
    connectorId: input.connectorId,
    type: "connector.mcp.credential_removed",
    executionScope,
    credentialAction: "removed",
    credentialVersion: result.credential.version,
    removed: result.removed,
  });
  return result;
}

export async function resolveMcpBearerCredential(connector: McpConnectorRecord) {
  if (connector.authType !== "bearer_vault") {
    throw new McpCredentialStoreError(
      "This MCP connector does not use an app-managed bearer credential.",
      409,
    );
  }
  const tenantId = connector.tenantId?.trim();
  if (!tenantId) {
    throw new McpCredentialStoreError(
      "A tenant id is required to resolve an MCP connector credential.",
      409,
    );
  }
  const endpointOrigin = mcpCredentialEndpointOrigin(connector.endpoint);

  return runWithDatabaseTenantScope(tenantId, async () => {
    let stored: InternalMcpCredential | undefined;
    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        SELECT id, endpoint, auth_type, credential_version, credential_key_id,
               credential_fingerprint, credential_origin, sealed_credential,
               credential_created_by, credential_rotated_by,
               credential_created_at, credential_rotated_at
        FROM omni_mcp_connectors
        WHERE id = ${connector.id}
          AND tenant_id = ${tenantId}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) {
        throw new McpCredentialStoreError("MCP connector not found.", 404);
      }
      if (String(row.auth_type) !== "bearer_vault") {
        throw new McpCredentialStoreError(
          "The MCP connector authentication mode changed before its credential was used.",
          409,
        );
      }
      if (mcpCredentialEndpointOrigin(String(row.endpoint)) !== endpointOrigin) {
        throw new McpCredentialStoreError(
          "The MCP connector endpoint changed before its credential was used.",
          409,
        );
      }
      stored = internalCredentialFromRow(row, connector.id, tenantId);
    } else {
      const ledger = await readJsonFile<InternalMcpConnectorLedger>(
        connectorLedgerFile(),
        emptyConnectorLedger(),
      );
      const currentConnector = ledger.connectors.find(
        (item) => item.id === connector.id && sameTenant(item.tenantId, tenantId),
      );
      if (!currentConnector) {
        throw new McpCredentialStoreError("MCP connector not found.", 404);
      }
      if (
        currentConnector.authType !== "bearer_vault" ||
        mcpCredentialEndpointOrigin(currentConnector.endpoint) !== endpointOrigin
      ) {
        throw new McpCredentialStoreError(
          "The MCP connector configuration changed before its credential was used.",
          409,
        );
      }
      stored = (ledger.credentials || []).find(
        (item) => item.connectorId === connector.id && sameTenant(item.tenantId, tenantId),
      );
    }

    if (!stored || !isStoredCredentialConfigured(stored)) {
      throw new McpCredentialStoreError(
        "The app-managed MCP bearer credential is not configured.",
        409,
      );
    }
    const storedOrigin = stored.origin;
    if (!storedOrigin || storedOrigin !== endpointOrigin) {
      throw new McpCredentialStoreError(
        "The stored MCP credential is bound to a different endpoint origin. Rotate it before reconnecting.",
        409,
      );
    }
    const credentials = openCredentialBundle(
      stored.sealedCredential as SealedCredentialPayload,
      mcpCredentialBinding({
        tenantId,
        connectorId: connector.id,
        origin: storedOrigin,
        credentialVersion: stored.version,
      }),
    );
    const token = credentials[MCP_CREDENTIAL_FIELD];
    validateBearerToken(token);
    if (mcpBearerFingerprint(token) !== stored.fingerprint) {
      throw new McpCredentialStoreError(
        "The app-managed MCP bearer credential failed its integrity check.",
        409,
      );
    }
    return token;
  });
}

export function credentialMetadata(
  stored: StoredCredentialFields,
  endpoint: string,
): McpConnectorCredentialMetadata {
  const configured = isStoredCredentialConfigured(stored);
  const version = positiveInteger(stored.version);
  const fingerprint = typeof stored.fingerprint === "string" && stored.fingerprint
    ? stored.fingerprint
    : undefined;
  const origin = typeof stored.origin === "string" ? stored.origin : undefined;
  let originMatch = false;
  if (configured && origin) {
    try {
      originMatch = mcpCredentialEndpointOrigin(endpoint) === origin;
    } catch {
      originMatch = false;
    }
  }
  return {
    configured,
    version,
    fingerprint: configured ? fingerprint : undefined,
    rotatedAt: normalizeDate(stored.rotatedAt),
    originMatch,
  };
}

export function connectorCredentialFields(
  credential: McpConnectorCredentialMetadata,
): Pick<
  McpConnectorRecord,
  | "credentialConfigured"
  | "credentialVersion"
  | "credentialFingerprint"
  | "credentialRotatedAt"
  | "credentialOriginMatch"
> {
  return {
    credentialConfigured: credential.configured,
    credentialVersion: credential.version,
    credentialFingerprint: credential.fingerprint,
    credentialRotatedAt: credential.rotatedAt,
    credentialOriginMatch: credential.originMatch,
  };
}

export function mcpCredentialEndpointOrigin(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    return url.origin;
  } catch {
    throw new McpCredentialStoreError("MCP endpoint origin is invalid.", 400);
  }
}

function internalCredentialFromRow(
  row: Record<string, unknown>,
  connectorId: string,
  tenantId: string,
): InternalMcpCredential | undefined {
  if (!isStoredCredentialConfigured({
    version: row.credential_version,
    keyId: row.credential_key_id,
    fingerprint: row.credential_fingerprint,
    origin: row.credential_origin,
    sealedCredential: row.sealed_credential,
  })) {
    return undefined;
  }
  return {
    connectorId,
    tenantId,
    origin: String(row.credential_origin),
    version: positiveInteger(row.credential_version)!,
    keyId: String(row.credential_key_id),
    fingerprint: String(row.credential_fingerprint || ""),
    sealedCredential: row.sealed_credential as SealedCredentialPayload,
    createdBy: String(row.credential_created_by || "unknown"),
    rotatedBy: String(row.credential_rotated_by || row.credential_created_by || "unknown"),
    createdAt: normalizeDate(row.credential_created_at) || new Date(0).toISOString(),
    rotatedAt: normalizeDate(row.credential_rotated_at) || new Date(0).toISOString(),
  };
}

function isStoredCredentialConfigured(stored: StoredCredentialFields) {
  return Boolean(
    positiveInteger(stored.version) &&
    typeof stored.keyId === "string" && stored.keyId &&
    typeof stored.fingerprint === "string" && /^[a-f0-9]{12}$/.test(stored.fingerprint) &&
    typeof stored.origin === "string" && stored.origin &&
    stored.sealedCredential && typeof stored.sealedCredential === "object",
  );
}

function mcpCredentialBinding(input: {
  tenantId: string;
  connectorId: string;
  origin: string;
  credentialVersion: number;
}) {
  return [
    MCP_CREDENTIAL_BINDING_PREFIX,
    input.tenantId,
    input.connectorId,
    input.origin,
    String(input.credentialVersion),
  ].join("\0");
}

function mcpBearerFingerprint(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}

function validateBearerToken(token: unknown): asserts token is string {
  if (
    typeof token !== "string" ||
    Buffer.byteLength(token, "utf8") < 8 ||
    Buffer.byteLength(token, "utf8") > MCP_CREDENTIAL_MAX_BYTES ||
    token.trim() !== token ||
    /[\r\n]/.test(token)
  ) {
    throw new McpCredentialStoreError(
      "The MCP bearer token must be a trimmed single-line value between 8 and 8192 bytes.",
      400,
    );
  }
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeDate(value: unknown) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function requireCredentialMutationScope(
  candidate: ExecutionScope | undefined,
  tenantId: string,
) {
  const executionScope = parsePersistedExecutionScope(candidate);
  if (!executionScope) {
    throw new McpCredentialStoreError(
      "MCP credential mutations require a trusted execution scope.",
      400,
    );
  }
  try {
    assertExecutionScopeTenant(executionScope, tenantId);
  } catch {
    throw new McpCredentialStoreError(
      "MCP credential execution scope does not match the authorized tenant.",
      400,
    );
  }
  if (!executionScope.executingPrincipalId) {
    throw new McpCredentialStoreError(
      "MCP credential mutations require an executing principal.",
      400,
    );
  }
  return executionScope;
}

function requireCredentialActor(executionScope: ExecutionScope) {
  const actorId = executionScope.initiatingActorId?.trim();
  if (
    !actorId ||
    executionScope.executingPrincipalType !== "user" ||
    executionScope.executingPrincipalId !== actorId
  ) {
    throw new McpCredentialStoreError(
      "MCP credential mutations require an authenticated user scope.",
      400,
    );
  }
  return actorId;
}

function sameTenant(value: string | undefined, tenantId: string) {
  return (value || process.env.OMNIAGENT_DEFAULT_TENANT || "default") === tenantId;
}

async function credentialEvent(input: {
  connectorId: string;
  type:
    | "connector.mcp.credential_saved"
    | "connector.mcp.credential_rotated"
    | "connector.mcp.credential_removed";
  executionScope: ExecutionScope;
  credentialAction: "saved" | "rotated" | "removed";
  credentialVersion?: number;
  credentialFingerprint?: string;
  credentialOrigin?: string;
  removed?: boolean;
}) {
  const executionScope = requireCredentialMutationScope(
    input.executionScope,
    input.executionScope.tenantId,
  );
  await appendScopedDomainEvent({
    streamId: `connector:${input.connectorId}`,
    type: input.type,
    executionScope,
    payload: {
      schemaVersion: 1,
      connectorId: input.connectorId,
      credentialAction: input.credentialAction,
      credentialVersion: input.credentialVersion,
      credentialFingerprint: input.credentialFingerprint,
      credentialOrigin: input.credentialOrigin,
      removed: input.removed,
    },
  });
}

function connectorLedgerFile() {
  return getDataPath("mcp-connectors.json");
}

function emptyConnectorLedger(): InternalMcpConnectorLedger {
  return { connectors: [], tools: [], credentials: [] };
}
