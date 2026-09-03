import { createHash, randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { appendDomainEventSafely } from "@/lib/events/store";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import {
  credentialBinding,
  openCredentialBundle,
  sealCredentialBundle,
  type SealedCredentialPayload,
} from "@/lib/settings/credential-vault";
import {
  SERVICE_API_SCOPES,
  type McpExportConfiguration,
  type ModelAssignment,
  type ModelAssignmentScope,
  type ModelCatalogEntry,
  type ProviderConnectionStatus,
  type RedactedProviderConnection,
  type RedactedServiceApiKey,
  type ServiceApiScope,
  type SettingsModelProvider,
} from "@/lib/settings/types";

type InternalProviderConnection = Omit<
  RedactedProviderConnection,
  "source" | "runtimeReadiness" | "runtimeNote"
> & {
  sealedCredentials: SealedCredentialPayload;
  credentialKeyId: string;
};

export type InternalServiceApiKey = RedactedServiceApiKey & {
  tokenHash: string;
};

type SettingsLedger = {
  providers: InternalProviderConnection[];
  models: ModelCatalogEntry[];
  assignments: ModelAssignment[];
  apiKeys: InternalServiceApiKey[];
  mcp: McpExportConfiguration[];
};

const emptyLedger: SettingsLedger = {
  providers: [],
  models: [],
  assignments: [],
  apiKeys: [],
  mcp: [],
};

export class SettingsStoreError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "SettingsStoreError";
  }
}

export async function listProviderConnections(input: {
  tenantId: string;
  actorId: string;
  includeDeploymentFallback?: boolean;
}) {
  const saved = await inTenant(input.tenantId, async () => {
    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        SELECT * FROM omni_provider_connections
        WHERE tenant_id = ${input.tenantId} AND actor_id = ${input.actorId}
        ORDER BY updated_at DESC
      `;
      return rows.map(providerFromRow).map(redactProvider);
    }
    const ledger = await readLedger();
    return ledger.providers
      .filter((item) => item.tenantId === input.tenantId && item.actorId === input.actorId)
      .sort((left, right) => right.updatedAt!.localeCompare(left.updatedAt!))
      .map(redactProvider);
  });
  return input.includeDeploymentFallback === false
    ? saved
    : [...saved, ...deploymentProviderConnections(input)];
}

export async function getProviderConnection(input: {
  tenantId: string;
  actorId: string;
  connectionId: string;
}) {
  return inTenant(input.tenantId, async () => {
    const record = await getInternalProviderById(input);
    return record ? redactProvider(record) : undefined;
  });
}

export async function saveProviderConnection(input: {
  tenantId: string;
  actorId: string;
  provider: SettingsModelProvider;
  label: string;
  credentials: Record<string, string>;
}) {
  return inTenant(input.tenantId, async () => {
    const existing = await findInternalProvider(input.tenantId, input.actorId, input.provider);
    const id = existing?.id || randomUUID();
    const version = (existing?.credentialVersion || 0) + 1;
    const now = new Date().toISOString();
    const binding = credentialBinding({
      tenantId: input.tenantId,
      actorId: input.actorId,
      connectionId: id,
      provider: input.provider,
      credentialVersion: version,
    });
    const sealedCredentials = sealCredentialBundle(input.credentials, binding);
    const fingerprint = credentialFingerprint(input.credentials);
    const configuredFields = Object.keys(input.credentials).sort();

    const record: InternalProviderConnection = {
      id,
      tenantId: input.tenantId,
      actorId: input.actorId,
      provider: input.provider,
      label: input.label.trim().slice(0, 120),
      status: "needs_validation",
      enabled: true,
      credentialVersion: version,
      credentialFingerprint: fingerprint,
      configuredFields,
      credentialKeyId: sealedCredentials.keyId,
      sealedCredentials,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      rotatedAt: existing ? now : undefined,
    };

    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        INSERT INTO omni_provider_connections (
          id, tenant_id, actor_id, provider, label, status, enabled,
          credential_version, credential_key_id, credential_fingerprint,
          configured_fields, sealed_credentials, created_at, updated_at, rotated_at
        ) VALUES (
          ${record.id}, ${record.tenantId}, ${record.actorId}, ${record.provider},
          ${record.label}, ${record.status}, ${record.enabled}, ${version},
          ${record.credentialKeyId}, ${record.credentialFingerprint},
          ${record.configuredFields}, ${record.sealedCredentials}::jsonb,
          ${record.createdAt}, ${record.updatedAt}, ${record.rotatedAt || null}
        )
        ON CONFLICT (tenant_id, actor_id, provider) DO UPDATE SET
          label = EXCLUDED.label,
          status = EXCLUDED.status,
          enabled = TRUE,
          credential_version = EXCLUDED.credential_version,
          credential_key_id = EXCLUDED.credential_key_id,
          credential_fingerprint = EXCLUDED.credential_fingerprint,
          configured_fields = EXCLUDED.configured_fields,
          sealed_credentials = EXCLUDED.sealed_credentials,
          validation_code = NULL,
          revoked_at = NULL,
          rotated_at = EXCLUDED.rotated_at,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `;
      const saved = providerFromRow(rows[0]);
      await providerEvent(saved, existing ? "settings.provider.rotated" : "settings.provider.saved");
      return redactProvider(saved);
    }

    await updateLedger((ledger) => ({
      ...ledger,
      providers: [
        ...ledger.providers.filter((item) => !(
          item.tenantId === input.tenantId &&
          item.actorId === input.actorId &&
          item.provider === input.provider
        )),
        record,
      ],
    }));
    await providerEvent(record, existing ? "settings.provider.rotated" : "settings.provider.saved");
    return redactProvider(record);
  });
}

export async function updateProviderConnection(input: {
  tenantId: string;
  actorId: string;
  connectionId: string;
  label?: string;
  enabled?: boolean;
}) {
  return inTenant(input.tenantId, async () => {
    const existing = await getInternalProviderById(input);
    if (!existing) throw new SettingsStoreError("Provider connection not found.", 404);
    const now = new Date().toISOString();
    const nextStatus: ProviderConnectionStatus = input.enabled === false
      ? "disabled"
      : existing.status === "disabled"
        ? "needs_validation"
        : existing.status;
    if (hasDatabaseUrl()) {
      const rows = await getSql()`
        UPDATE omni_provider_connections SET
          label = ${input.label?.trim().slice(0, 120) || existing.label},
          enabled = ${input.enabled ?? existing.enabled},
          status = ${nextStatus},
          updated_at = ${now}
        WHERE id = ${input.connectionId}
          AND tenant_id = ${input.tenantId} AND actor_id = ${input.actorId}
        RETURNING *
      `;
      const saved = providerFromRow(rows[0]);
      await providerEvent(saved, "settings.provider.updated");
      return redactProvider(saved);
    }
    let saved = existing;
    await updateLedger((ledger) => ({
      ...ledger,
      providers: ledger.providers.map((item) => {
        if (item.id !== existing.id || item.tenantId !== input.tenantId || item.actorId !== input.actorId) return item;
        saved = {
          ...item,
          label: input.label?.trim().slice(0, 120) || item.label,
          enabled: input.enabled ?? item.enabled,
          status: nextStatus,
          updatedAt: now,
        };
        return saved;
      }),
    }));
    await providerEvent(saved, "settings.provider.updated");
    return redactProvider(saved);
  });
}

export async function revokeProviderConnection(input: {
  tenantId: string;
  actorId: string;
  connectionId: string;
}) {
  return inTenant(input.tenantId, async () => {
    const existing = await getInternalProviderById(input);
    if (!existing) throw new SettingsStoreError("Provider connection not found.", 404);
    const now = new Date().toISOString();
    const credentialVersion = (existing.credentialVersion || 0) + 1;
    const sealedCredentials = sealCredentialBundle({}, credentialBinding({
      tenantId: input.tenantId,
      actorId: input.actorId,
      connectionId: existing.id,
      provider: existing.provider,
      credentialVersion,
    }));
    if (hasDatabaseUrl()) {
      const rows = await getSql()`
        UPDATE omni_provider_connections SET
          status = 'revoked', enabled = FALSE,
          credential_version = ${credentialVersion},
          credential_key_id = ${sealedCredentials.keyId},
          credential_fingerprint = NULL,
          configured_fields = '{}',
          sealed_credentials = ${sealedCredentials}::jsonb,
          validation_code = NULL, revoked_at = ${now}, updated_at = ${now}
        WHERE id = ${input.connectionId}
          AND tenant_id = ${input.tenantId} AND actor_id = ${input.actorId}
        RETURNING *
      `;
      const saved = providerFromRow(rows[0]);
      await providerEvent(saved, "settings.provider.revoked");
      return redactProvider(saved);
    }
    let saved = existing;
    await updateLedger((ledger) => ({
      ...ledger,
      providers: ledger.providers.map((item) => {
        if (item.id !== existing.id || item.tenantId !== input.tenantId || item.actorId !== input.actorId) return item;
        saved = {
          ...item,
          status: "revoked",
          enabled: false,
          credentialVersion,
          credentialKeyId: sealedCredentials.keyId,
          credentialFingerprint: undefined,
          configuredFields: [],
          sealedCredentials,
          validationCode: undefined,
          updatedAt: now,
        };
        return saved;
      }),
    }));
    await providerEvent(saved, "settings.provider.revoked");
    return redactProvider(saved);
  });
}

export async function getProviderCredentials(input: {
  tenantId: string;
  actorId: string;
  connectionId: string;
}) {
  return inTenant(input.tenantId, async () => {
    const record = await getInternalProviderById(input);
    if (!record || record.status === "revoked") {
      throw new SettingsStoreError("Provider connection not found.", 404);
    }
    return {
      connection: redactProvider(record),
      credentials: openCredentialBundle(record.sealedCredentials, credentialBinding({
        tenantId: record.tenantId,
        actorId: record.actorId,
        connectionId: record.id,
        provider: record.provider,
        credentialVersion: record.credentialVersion || 1,
      })),
    };
  });
}

export async function setProviderValidationState(input: {
  tenantId: string;
  actorId: string;
  connectionId: string;
  status: "validating" | "connected" | "error";
  validationCode?: string;
  catalogRefreshedAt?: string;
}) {
  return inTenant(input.tenantId, async () => {
    const existing = await getInternalProviderById(input);
    if (!existing) throw new SettingsStoreError("Provider connection not found.", 404);
    const now = new Date().toISOString();
    const validatedAt = input.status === "validating" ? existing.lastValidatedAt : now;
    if (hasDatabaseUrl()) {
      const rows = await getSql()`
        UPDATE omni_provider_connections SET
          status = ${input.status},
          validation_code = ${input.validationCode || null},
          last_validated_at = ${validatedAt || null},
          catalog_refreshed_at = ${input.catalogRefreshedAt || existing.catalogRefreshedAt || null},
          updated_at = ${now}
        WHERE id = ${input.connectionId}
          AND tenant_id = ${input.tenantId} AND actor_id = ${input.actorId}
        RETURNING *
      `;
      const saved = providerFromRow(rows[0]);
      if (input.status !== "validating") await providerEvent(saved, `settings.provider.${input.status}`);
      return redactProvider(saved);
    }
    let saved = existing;
    await updateLedger((ledger) => ({
      ...ledger,
      providers: ledger.providers.map((item) => {
        if (item.id !== existing.id || item.tenantId !== input.tenantId || item.actorId !== input.actorId) return item;
        saved = {
          ...item,
          status: input.status,
          validationCode: input.validationCode,
          lastValidatedAt: validatedAt,
          catalogRefreshedAt: input.catalogRefreshedAt || item.catalogRefreshedAt,
          updatedAt: now,
        };
        return saved;
      }),
    }));
    if (input.status !== "validating") await providerEvent(saved, `settings.provider.${input.status}`);
    return redactProvider(saved);
  });
}

export async function listModelCatalog(input: { tenantId: string; actorId: string }) {
  return inTenant(input.tenantId, async () => {
    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        SELECT * FROM omni_model_catalog
        WHERE tenant_id = ${input.tenantId} AND actor_id = ${input.actorId}
        ORDER BY provider, display_name, model_id
      `;
      return rows.map(modelFromRow);
    }
    const ledger = await readLedger();
    return ledger.models.filter((item) => item.tenantId === input.tenantId && item.actorId === input.actorId);
  });
}

export async function saveModelCatalog(input: {
  tenantId: string;
  actorId: string;
  provider: SettingsModelProvider;
  models: Array<Omit<ModelCatalogEntry, "id" | "tenantId" | "actorId" | "provider" | "discoveredAt" | "updatedAt">>;
}) {
  return inTenant(input.tenantId, async () => {
    const now = new Date().toISOString();
    const previous = (await listModelCatalog(input)).filter(
      (model) => model.provider === input.provider,
    );
    const records: ModelCatalogEntry[] = input.models.map((model) => ({
      ...model,
      id: createHash("sha256").update(`${input.tenantId}\0${input.actorId}\0${input.provider}\0${model.modelId}`).digest("hex"),
      tenantId: input.tenantId,
      actorId: input.actorId,
      provider: input.provider,
      discoveredAt: now,
      updatedAt: now,
    }));
    const incomingModelIds = new Set(records.map((record) => record.modelId));
    const missingModels = previous
      .filter((record) => !incomingModelIds.has(record.modelId))
      .map((record): ModelCatalogEntry => ({
        ...record,
        lifecycle: "retiring",
        lifecycleReason:
          "The model was returned previously but is absent from the latest provider catalog. Review its assignments before the next refresh.",
        lifecycleCheckedAt: now,
        updatedAt: now,
      }));
    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      for (const record of records) {
        await getSql()`
          INSERT INTO omni_model_catalog (
            id, tenant_id, actor_id, provider, model_id, display_name,
            capabilities, lifecycle, lifecycle_reason, lifecycle_checked_at,
            discovered_at, updated_at
          ) VALUES (
            ${record.id}, ${record.tenantId}, ${record.actorId}, ${record.provider},
            ${record.modelId}, ${record.displayName}, ${record.capabilities},
            ${record.lifecycle}, ${record.lifecycleReason || null},
            ${record.lifecycleCheckedAt || null}, ${record.discoveredAt}, ${record.updatedAt}
          ) ON CONFLICT (tenant_id, actor_id, provider, model_id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            capabilities = EXCLUDED.capabilities,
            lifecycle = EXCLUDED.lifecycle,
            lifecycle_reason = EXCLUDED.lifecycle_reason,
            lifecycle_checked_at = EXCLUDED.lifecycle_checked_at,
            updated_at = EXCLUDED.updated_at
        `;
      }
      for (const record of missingModels) {
        await getSql()`
          UPDATE omni_model_catalog SET
            lifecycle = 'retiring',
            lifecycle_reason = ${record.lifecycleReason || null},
            lifecycle_checked_at = ${record.lifecycleCheckedAt || now},
            updated_at = ${now}
          WHERE id = ${record.id}
            AND tenant_id = ${record.tenantId}
            AND actor_id = ${record.actorId}
        `;
      }
    } else {
      await updateLedger((ledger) => ({
        ...ledger,
        models: [
          ...ledger.models.filter((item) => !(
            item.tenantId === input.tenantId && item.actorId === input.actorId && item.provider === input.provider
          )),
          ...records,
          ...missingModels,
        ],
      }));
    }
    await appendDomainEventSafely({
      streamId: `settings:${input.actorId}`,
      type: "settings.models.refreshed",
      tenantId: input.tenantId,
      actorId: input.actorId,
      payload: { provider: input.provider, modelCount: records.length },
    });
    return [...records, ...missingModels];
  });
}

export async function listModelAssignments(input: { tenantId: string; actorId: string }) {
  return inTenant(input.tenantId, async () => {
    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        SELECT * FROM omni_model_assignments
        WHERE tenant_id = ${input.tenantId} AND actor_id = ${input.actorId}
        ORDER BY scope
      `;
      return rows.map(assignmentFromRow);
    }
    const ledger = await readLedger();
    return ledger.assignments
      .filter((item) => item.tenantId === input.tenantId && item.actorId === input.actorId)
      .map((item) => ({
        ...item,
        runtimeReadiness: assignmentRuntimeReadiness(item.scope),
        runtimeNote: assignmentRuntimeNote(item.scope),
      }));
  });
}

export async function saveModelAssignment(input: {
  tenantId: string;
  actorId: string;
  scope: ModelAssignmentScope;
  provider: SettingsModelProvider;
  modelId: string;
  fallbackProvider?: SettingsModelProvider;
  fallbackModelId?: string;
  crossProviderFallbackConsent?: boolean;
}) {
  const crossProvider = Boolean(input.fallbackProvider && input.fallbackProvider !== input.provider);
  if (crossProvider && input.crossProviderFallbackConsent !== true) {
    throw new SettingsStoreError(
      "Cross-provider fallback requires explicit consent because task content may be sent to another provider.",
      409,
    );
  }
  if (Boolean(input.fallbackProvider) !== Boolean(input.fallbackModelId)) {
    throw new SettingsStoreError("Fallback provider and fallback model must be selected together.");
  }
  return inTenant(input.tenantId, async () => {
    const now = new Date().toISOString();
    const existing = (await listModelAssignments(input)).find((item) => item.scope === input.scope);
    const record: ModelAssignment = {
      id: existing?.id || randomUUID(),
      tenantId: input.tenantId,
      actorId: input.actorId,
      scope: input.scope,
      provider: input.provider,
      modelId: input.modelId.trim().slice(0, 240),
      fallbackProvider: input.fallbackProvider,
      fallbackModelId: input.fallbackModelId?.trim().slice(0, 240),
      allowCrossProviderFallback: crossProvider,
      runtimeReadiness: assignmentRuntimeReadiness(input.scope),
      runtimeNote: assignmentRuntimeNote(input.scope),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (hasDatabaseUrl()) {
      const rows = await getSql()`
        INSERT INTO omni_model_assignments (
          id, tenant_id, actor_id, scope, provider, model_id,
          fallback_provider, fallback_model_id, allow_cross_provider_fallback,
          runtime_readiness, created_at, updated_at
        ) VALUES (
          ${record.id}, ${record.tenantId}, ${record.actorId}, ${record.scope},
          ${record.provider}, ${record.modelId}, ${record.fallbackProvider || null},
          ${record.fallbackModelId || null}, ${record.allowCrossProviderFallback},
          ${"configuration_only"}, ${record.createdAt}, ${record.updatedAt}
        ) ON CONFLICT (tenant_id, actor_id, scope) DO UPDATE SET
          provider = EXCLUDED.provider,
          model_id = EXCLUDED.model_id,
          fallback_provider = EXCLUDED.fallback_provider,
          fallback_model_id = EXCLUDED.fallback_model_id,
          allow_cross_provider_fallback = EXCLUDED.allow_cross_provider_fallback,
          runtime_readiness = EXCLUDED.runtime_readiness,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `;
      const saved = assignmentFromRow(rows[0]);
      await assignmentEvent(saved);
      return saved;
    }
    await updateLedger((ledger) => ({
      ...ledger,
      assignments: [
        ...ledger.assignments.filter((item) => !(
          item.tenantId === input.tenantId && item.actorId === input.actorId && item.scope === input.scope
        )),
        record,
      ],
    }));
    await assignmentEvent(record);
    return record;
  });
}

export async function listServiceApiKeyRecords(input: { tenantId: string; actorId?: string }) {
  return inTenant(input.tenantId, async () => {
    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      const rows = input.actorId
        ? await getSql()`SELECT * FROM omni_service_api_keys WHERE tenant_id = ${input.tenantId} AND actor_id = ${input.actorId} ORDER BY created_at DESC`
        : await getSql()`SELECT * FROM omni_service_api_keys WHERE tenant_id = ${input.tenantId} ORDER BY created_at DESC`;
      return rows.map(serviceKeyFromRow);
    }
    const ledger = await readLedger();
    return ledger.apiKeys
      .filter((item) => item.tenantId === input.tenantId && (!input.actorId || item.actorId === input.actorId))
      .map(effectiveServiceKeyStatus);
  });
}

export async function getServiceApiKeyRecord(input: { tenantId: string; keyId: string }) {
  return inTenant(input.tenantId, async () => {
    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        SELECT * FROM omni_service_api_keys
        WHERE tenant_id = ${input.tenantId} AND id = ${input.keyId}
        LIMIT 1
      `;
      return rows[0] ? serviceKeyFromRow(rows[0]) : undefined;
    }
    const ledger = await readLedger();
    const record = ledger.apiKeys.find((item) => item.tenantId === input.tenantId && item.id === input.keyId);
    return record ? effectiveServiceKeyStatus(record) : undefined;
  });
}

export async function insertServiceApiKey(record: InternalServiceApiKey) {
  return inTenant(record.tenantId, async () => {
    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        INSERT INTO omni_service_api_keys (
          id, tenant_id, actor_id, name, token_hash, token_prefix,
          token_last_four, scopes, status, expires_at, created_at, updated_at
        ) VALUES (
          ${record.id}, ${record.tenantId}, ${record.actorId}, ${record.name},
          ${record.tokenHash}, ${record.tokenPrefix}, ${record.tokenLastFour},
          ${record.scopes}, ${record.status}, ${record.expiresAt || null},
          ${record.createdAt}, ${record.updatedAt}
        ) RETURNING *
      `;
      return serviceKeyFromRow(rows[0]);
    }
    await updateLedger((ledger) => ({ ...ledger, apiKeys: [record, ...ledger.apiKeys] }));
    return record;
  });
}

export async function updateServiceApiKeyRecord(input: {
  tenantId: string;
  actorId: string;
  keyId: string;
  status?: "revoked";
  lastUsedAt?: string;
}) {
  return inTenant(input.tenantId, async () => {
    const now = new Date().toISOString();
    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        UPDATE omni_service_api_keys SET
          status = COALESCE(${input.status || null}, status),
          revoked_at = CASE WHEN ${input.status || null} = 'revoked' THEN ${now}::timestamptz ELSE revoked_at END,
          last_used_at = COALESCE(${input.lastUsedAt || null}, last_used_at),
          updated_at = ${now}
        WHERE id = ${input.keyId} AND tenant_id = ${input.tenantId} AND actor_id = ${input.actorId}
        RETURNING *
      `;
      return rows[0] ? serviceKeyFromRow(rows[0]) : undefined;
    }
    let saved: InternalServiceApiKey | undefined;
    await updateLedger((ledger) => ({
      ...ledger,
      apiKeys: ledger.apiKeys.map((item) => {
        if (item.id !== input.keyId || item.tenantId !== input.tenantId || item.actorId !== input.actorId) return item;
        saved = {
          ...item,
          status: input.status || item.status,
          revokedAt: input.status === "revoked" ? now : item.revokedAt,
          lastUsedAt: input.lastUsedAt || item.lastUsedAt,
          updatedAt: now,
        };
        return saved;
      }),
    }));
    return saved;
  });
}

export async function getMcpExportConfiguration(input: { tenantId: string; actorId: string }) {
  return inTenant(input.tenantId, async () => {
    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        SELECT * FROM omni_mcp_export_configurations
        WHERE tenant_id = ${input.tenantId} AND actor_id = ${input.actorId}
        LIMIT 1
      `;
      return rows[0] ? mcpConfigFromRow(rows[0]) : defaultMcpConfig(input);
    }
    const ledger = await readLedger();
    return ledger.mcp.find((item) => item.tenantId === input.tenantId && item.actorId === input.actorId) || defaultMcpConfig(input);
  });
}

export async function saveMcpExportConfiguration(input: {
  tenantId: string;
  actorId: string;
  enabled: boolean;
  serverName: string;
  allowedScopes: ServiceApiScope[];
  exposeResources: boolean;
}) {
  const allowedScopes = input.allowedScopes.filter((scope): scope is ServiceApiScope =>
    SERVICE_API_SCOPES.includes(scope as ServiceApiScope)
  );
  return inTenant(input.tenantId, async () => {
    const existing = await getMcpExportConfiguration(input);
    const now = new Date().toISOString();
    const record: McpExportConfiguration = {
      ...existing,
      enabled: input.enabled,
      serverName: input.serverName.trim().slice(0, 120) || "Asael",
      allowedScopes: [...new Set(allowedScopes)],
      exposeResources: input.exposeResources,
      readiness: input.enabled ? "ready" : "disabled",
      updatedAt: now,
    };
    if (hasDatabaseUrl()) {
      const rows = await getSql()`
        INSERT INTO omni_mcp_export_configurations (
          tenant_id, actor_id, enabled, server_name, allowed_scopes,
          default_approval_mode, expose_resources, created_at, updated_at
        ) VALUES (
          ${record.tenantId}, ${record.actorId}, ${record.enabled}, ${record.serverName},
          ${record.allowedScopes}, ${record.defaultApprovalMode}, ${record.exposeResources},
          ${record.createdAt}, ${record.updatedAt}
        ) ON CONFLICT (tenant_id, actor_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          server_name = EXCLUDED.server_name,
          allowed_scopes = EXCLUDED.allowed_scopes,
          expose_resources = EXCLUDED.expose_resources,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `;
      const saved = mcpConfigFromRow(rows[0]);
      await mcpEvent(saved);
      return saved;
    }
    await updateLedger((ledger) => ({
      ...ledger,
      mcp: [
        ...ledger.mcp.filter((item) => !(item.tenantId === input.tenantId && item.actorId === input.actorId)),
        record,
      ],
    }));
    await mcpEvent(record);
    return record;
  });
}

function deploymentProviderConnections(input: { tenantId: string; actorId: string }) {
  const configs: Array<{
    provider: SettingsModelProvider;
    label: string;
    configured: boolean;
    fields: string[];
  }> = [
    { provider: "openai", label: "OpenAI deployment key", configured: Boolean(process.env.OPENAI_API_KEY?.trim()), fields: ["apiKey"] },
    { provider: "google", label: "Google Gemini deployment key", configured: Boolean((process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)?.trim()), fields: ["apiKey"] },
    { provider: "anthropic", label: "Anthropic deployment key", configured: Boolean(process.env.ANTHROPIC_API_KEY?.trim()), fields: ["apiKey"] },
    { provider: "aws_bedrock", label: "AWS Bedrock deployment identity", configured: Boolean(process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim()), fields: ["accessKeyId", "secretAccessKey", "region"] },
  ];
  return configs.filter((item) => item.configured).map((item): RedactedProviderConnection => ({
    id: `env:${item.provider}`,
    tenantId: input.tenantId,
    actorId: input.actorId,
    provider: item.provider,
    label: item.label,
    source: "deployment_environment",
    status: "connected",
    enabled: true,
    configuredFields: item.fields,
    runtimeReadiness: "active_environment_fallback",
    runtimeNote: "Active runtime fallback managed by the deployment environment. Its value is never returned here.",
  }));
}

async function findInternalProvider(tenantId: string, actorId: string, provider: SettingsModelProvider) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_provider_connections
      WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND provider = ${provider}
      LIMIT 1
    `;
    return rows[0] ? providerFromRow(rows[0]) : undefined;
  }
  const ledger = await readLedger();
  return ledger.providers.find((item) => item.tenantId === tenantId && item.actorId === actorId && item.provider === provider);
}

async function getInternalProviderById(input: { tenantId: string; actorId: string; connectionId: string }) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_provider_connections
      WHERE id = ${input.connectionId} AND tenant_id = ${input.tenantId} AND actor_id = ${input.actorId}
      LIMIT 1
    `;
    return rows[0] ? providerFromRow(rows[0]) : undefined;
  }
  const ledger = await readLedger();
  return ledger.providers.find((item) => item.id === input.connectionId && item.tenantId === input.tenantId && item.actorId === input.actorId);
}

function redactProvider(record: InternalProviderConnection): RedactedProviderConnection {
  return {
    id: record.id,
    tenantId: record.tenantId,
    actorId: record.actorId,
    provider: record.provider,
    label: record.label,
    source: "tenant_vault",
    status: record.status,
    enabled: record.enabled,
    credentialVersion: record.credentialVersion,
    credentialFingerprint: record.credentialFingerprint,
    configuredFields: record.configuredFields,
    lastValidatedAt: record.lastValidatedAt,
    validationCode: record.validationCode,
    catalogRefreshedAt: record.catalogRefreshedAt,
    runtimeReadiness: "active_tenant_runtime",
    runtimeNote: "Available to the tenant runtime when assigned to Main agent or Orchestrator. Other saved routing scopes remain configuration-only.",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    rotatedAt: record.rotatedAt,
  };
}

function providerFromRow(row: Record<string, unknown>): InternalProviderConnection {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    provider: String(row.provider) as SettingsModelProvider,
    label: String(row.label),
    status: String(row.status) as ProviderConnectionStatus,
    enabled: Boolean(row.enabled),
    credentialVersion: Number(row.credential_version),
    credentialFingerprint: row.credential_fingerprint ? String(row.credential_fingerprint) : undefined,
    configuredFields: Array.isArray(row.configured_fields) ? row.configured_fields.map(String) : [],
    credentialKeyId: String(row.credential_key_id),
    sealedCredentials: row.sealed_credentials as SealedCredentialPayload,
    lastValidatedAt: optionalDate(row.last_validated_at),
    validationCode: row.validation_code ? String(row.validation_code) : undefined,
    catalogRefreshedAt: optionalDate(row.catalog_refreshed_at),
    createdAt: optionalDate(row.created_at),
    updatedAt: optionalDate(row.updated_at),
    rotatedAt: optionalDate(row.rotated_at),
  };
}

function modelFromRow(row: Record<string, unknown>): ModelCatalogEntry {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id),
    provider: String(row.provider) as SettingsModelProvider, modelId: String(row.model_id),
    displayName: String(row.display_name), capabilities: Array.isArray(row.capabilities) ? row.capabilities.map(String) : [],
    lifecycle: String(row.lifecycle) as ModelCatalogEntry["lifecycle"],
    lifecycleReason: row.lifecycle_reason ? String(row.lifecycle_reason) : undefined,
    lifecycleCheckedAt: optionalDate(row.lifecycle_checked_at),
    discoveredAt: optionalDate(row.discovered_at) || new Date().toISOString(),
    updatedAt: optionalDate(row.updated_at) || new Date().toISOString(),
  };
}

function assignmentFromRow(row: Record<string, unknown>): ModelAssignment {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id),
    scope: String(row.scope) as ModelAssignmentScope,
    provider: String(row.provider) as SettingsModelProvider, modelId: String(row.model_id),
    fallbackProvider: row.fallback_provider ? String(row.fallback_provider) as SettingsModelProvider : undefined,
    fallbackModelId: row.fallback_model_id ? String(row.fallback_model_id) : undefined,
    allowCrossProviderFallback: Boolean(row.allow_cross_provider_fallback),
    runtimeReadiness: assignmentRuntimeReadiness(String(row.scope) as ModelAssignmentScope),
    runtimeNote: assignmentRuntimeNote(String(row.scope) as ModelAssignmentScope),
    createdAt: optionalDate(row.created_at) || new Date().toISOString(),
    updatedAt: optionalDate(row.updated_at) || new Date().toISOString(),
  };
}

function assignmentRuntimeReadiness(scope: ModelAssignmentScope): ModelAssignment["runtimeReadiness"] {
  return scope === "main_agent" || scope === "orchestrator"
    ? "active"
    : "configuration_only";
}

function assignmentRuntimeNote(scope: ModelAssignmentScope) {
  return assignmentRuntimeReadiness(scope) === "active"
    ? "Tenant credentials and the saved model route are consumed server-side for this runtime path, with deployment routing retained as a safe fallback."
    : "Policy is saved. This runtime path still uses deployment-environment routing until its tenant adapter is enabled.";
}

function serviceKeyFromRow(row: Record<string, unknown>): InternalServiceApiKey {
  const expiresAt = optionalDate(row.expires_at);
  const storedStatus = String(row.status) as RedactedServiceApiKey["status"];
  return {
    id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id),
    name: String(row.name), tokenHash: String(row.token_hash), tokenPrefix: String(row.token_prefix),
    tokenLastFour: String(row.token_last_four),
    scopes: (Array.isArray(row.scopes) ? row.scopes : []).filter((item): item is ServiceApiScope => SERVICE_API_SCOPES.includes(String(item) as ServiceApiScope)),
    status: storedStatus === "active" && expiresAt && Date.parse(expiresAt) <= Date.now() ? "expired" : storedStatus,
    expiresAt, lastUsedAt: optionalDate(row.last_used_at), createdAt: optionalDate(row.created_at) || new Date().toISOString(),
    updatedAt: optionalDate(row.updated_at) || new Date().toISOString(), revokedAt: optionalDate(row.revoked_at),
  };
}

function effectiveServiceKeyStatus(record: InternalServiceApiKey): InternalServiceApiKey {
  return record.status === "active" && record.expiresAt && Date.parse(record.expiresAt) <= Date.now()
    ? { ...record, status: "expired" }
    : record;
}

function mcpConfigFromRow(row: Record<string, unknown>): McpExportConfiguration {
  const enabled = Boolean(row.enabled);
  return {
    tenantId: String(row.tenant_id), actorId: String(row.actor_id), enabled,
    serverName: String(row.server_name),
    allowedScopes: (Array.isArray(row.allowed_scopes) ? row.allowed_scopes : []).filter((item): item is ServiceApiScope => SERVICE_API_SCOPES.includes(String(item) as ServiceApiScope)),
    defaultApprovalMode: "governed", exposeResources: Boolean(row.expose_resources),
    endpointPath: "/api/mcp", readiness: enabled ? "ready" : "disabled",
    createdAt: optionalDate(row.created_at) || new Date().toISOString(), updatedAt: optionalDate(row.updated_at) || new Date().toISOString(),
  };
}

function defaultMcpConfig(input: { tenantId: string; actorId: string }): McpExportConfiguration {
  const now = new Date().toISOString();
  return {
    ...input, enabled: false, serverName: "Asael", allowedScopes: ["mcp:discover", "mcp:tools:list"],
    defaultApprovalMode: "governed", exposeResources: false, endpointPath: "/api/mcp",
    readiness: "disabled", createdAt: now, updatedAt: now,
  };
}

function credentialFingerprint(credentials: Record<string, string>) {
  const primary = credentials.apiKey || credentials.secretAccessKey || credentials.accessKeyId || Object.values(credentials)[0] || "";
  return createHash("sha256").update(primary, "utf8").digest("hex").slice(0, 12);
}

function optionalDate(value: unknown) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function providerEvent(record: InternalProviderConnection, type: string) {
  await appendDomainEventSafely({
    streamId: `settings:${record.actorId}`, type, tenantId: record.tenantId, actorId: record.actorId,
    payload: { connectionId: record.id, provider: record.provider, status: record.status, credentialVersion: record.credentialVersion },
  });
}

async function assignmentEvent(record: ModelAssignment) {
  await appendDomainEventSafely({
    streamId: `settings:${record.actorId}`, type: "settings.model_assignment.saved", tenantId: record.tenantId, actorId: record.actorId,
    payload: { scope: record.scope, provider: record.provider, modelId: record.modelId, fallbackProvider: record.fallbackProvider, allowCrossProviderFallback: record.allowCrossProviderFallback },
  });
}

async function mcpEvent(record: McpExportConfiguration) {
  await appendDomainEventSafely({
    streamId: `settings:${record.actorId}`, type: "settings.mcp_export.updated", tenantId: record.tenantId, actorId: record.actorId,
    payload: { enabled: record.enabled, allowedScopes: record.allowedScopes, exposeResources: record.exposeResources },
  });
}

async function inTenant<T>(tenantId: string, operation: () => Promise<T>) {
  return runWithDatabaseTenantScope(tenantId, operation);
}

function readLedger() {
  return readJsonFile<SettingsLedger>(settingsFile(), emptyLedger);
}

function updateLedger(mutate: (ledger: SettingsLedger) => SettingsLedger | Promise<SettingsLedger>) {
  return updateJsonFile<SettingsLedger>(settingsFile(), emptyLedger, mutate);
}

function settingsFile() {
  return getDataPath("settings-control-plane.json");
}
