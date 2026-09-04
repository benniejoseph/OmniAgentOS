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
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import {
  credentialBinding,
  openCredentialBundle,
  sealCredentialBundle,
  type SealedCredentialPayload,
} from "@/lib/settings/credential-vault";
import { modelAssignmentActorReadOrder } from "@/lib/settings/model-assignment-actor-scope";
import { modelCatalogActorReadOrder } from "@/lib/settings/model-catalog-actor-scope";
import { providerConnectionActorReadOrder } from "@/lib/settings/provider-connection-actor-scope";
import { serviceApiKeyActorReadOrder } from "@/lib/settings/service-api-key-actor-scope";
import {
  MODEL_ASSIGNMENT_SCOPES,
  MODEL_PROVIDERS,
  SERVICE_API_SCOPES,
  type McpExportConfiguration,
  type ModelAssignment,
  type ModelAssignmentScope,
  type ModelCatalogEntry,
  type ModelLifecycleState,
  type ProviderConnectionStatus,
  type RequestModelAssignment,
  type RedactedProviderConnection,
  type RedactedServiceApiKey,
  type RequestModelCatalogEntry,
  type RequestProviderConnection,
  type RequestServiceApiKey,
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

export class ModelAssignmentReadConflictError extends SettingsStoreError {
  constructor(message = "Model assignment ownership is ambiguous.") {
    super(message, 409);
    this.name = "ModelAssignmentReadConflictError";
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

export async function listProviderConnectionsForRequest(input: {
  tenantId: string;
  actorId: string;
  requestActorBinding?: CanonicalRequestActorBindingV1;
  includeDeploymentFallback?: boolean;
}): Promise<RequestProviderConnection[]> {
  const saved = await inTenant(input.tenantId, async () => {
    if (!hasDatabaseUrl()) {
      const ledger = await readLedger();
      const records = ledger.providers
        .filter((item) =>
          item.tenantId === input.tenantId && item.actorId === input.actorId
        )
        .map((record) => {
          const row = providerConnectionLedgerRow(record);
          assertRequestProviderConnectionRow(
            row,
            input.tenantId,
            input.actorId,
            input.actorId,
          );
          return providerConnectionMetadataFromRow(row);
        });
      assertRequestProviderConnectionRecords(
        records,
        input.tenantId,
        input.actorId,
        input.actorId,
      );
      return records
        .sort(compareProviderConnectionMetadata)
        .map((record) => requestProviderConnection(record, input.actorId));
    }

    const [canonicalActorId, exactActorId] =
      providerConnectionActorReadOrder(
        input.actorId,
        input.requestActorBinding,
      );
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT id, tenant_id, actor_id, provider, label, status, enabled,
        credential_version, credential_fingerprint, configured_fields,
        last_validated_at, validation_code, catalog_refreshed_at, created_at,
        updated_at, rotated_at
      FROM omni_provider_connections
      WHERE tenant_id = ${input.tenantId}
        AND actor_id IN (${canonicalActorId}, ${exactActorId})
        AND tenant_id COLLATE "C" = ${input.tenantId}::text COLLATE "C"
        AND (
          actor_id COLLATE "C" = ${canonicalActorId}::text COLLATE "C"
          OR actor_id COLLATE "C" = ${exactActorId}::text COLLATE "C"
        )
      ORDER BY updated_at DESC, id COLLATE "C"
    `;
    const records = rows.map((row) => {
      assertRequestProviderConnectionRow(
        row,
        input.tenantId,
        canonicalActorId,
        exactActorId,
      );
      return providerConnectionMetadataFromRow(row);
    });
    assertRequestProviderConnectionRecords(
      records,
      input.tenantId,
      canonicalActorId,
      exactActorId,
    );
    return records.map((record) =>
      requestProviderConnection(record, exactActorId)
    );
  });

  return input.includeDeploymentFallback === false
    ? saved
    : [
        ...saved,
        ...deploymentProviderConnections(input).map((record) => ({
          ...record,
          manageable: false,
        })),
      ];
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

export async function listModelCatalogForRequest(input: {
  tenantId: string;
  actorId: string;
  requestActorBinding?: CanonicalRequestActorBindingV1;
}): Promise<RequestModelCatalogEntry[]> {
  return inTenant(input.tenantId, async () => {
    if (!hasDatabaseUrl()) {
      const ledger = await readLedger();
      const records = ledger.models
        .filter((item) =>
          item.tenantId === input.tenantId && item.actorId === input.actorId
        )
        .map((record) => {
          const row = modelCatalogLedgerRow(record);
          assertRequestModelCatalogRow(
            row,
            input.tenantId,
            input.actorId,
            input.actorId,
          );
          return modelFromRow(row);
        });
      assertRequestModelCatalogRecords(
        records,
        input.tenantId,
        input.actorId,
        input.actorId,
      );
      return records.map((record) =>
        requestModelCatalogEntry(record, input.actorId)
      );
    }
    const [canonicalActorId, exactActorId] = modelCatalogActorReadOrder(
      input.actorId,
      input.requestActorBinding,
      input.actorId,
    );
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT id, tenant_id, actor_id, provider, model_id, display_name,
        capabilities, lifecycle, lifecycle_reason, lifecycle_checked_at,
        discovered_at, updated_at
      FROM omni_model_catalog
      WHERE tenant_id = ${input.tenantId}
        AND actor_id IN (${canonicalActorId}, ${exactActorId})
        AND tenant_id COLLATE "C" = ${input.tenantId}::text COLLATE "C"
        AND (
          actor_id COLLATE "C" = ${canonicalActorId}::text COLLATE "C"
          OR actor_id COLLATE "C" = ${exactActorId}::text COLLATE "C"
        )
      ORDER BY provider COLLATE "C", display_name COLLATE "C",
        model_id COLLATE "C", id COLLATE "C"
    `;
    const records = rows.map((row) => {
      assertRequestModelCatalogRow(
        row,
        input.tenantId,
        canonicalActorId,
        exactActorId,
      );
      return modelFromRow(row);
    });
    assertRequestModelCatalogRecords(
      records,
      input.tenantId,
      canonicalActorId,
      exactActorId,
    );
    return records.map((record) =>
      requestModelCatalogEntry(record, exactActorId)
    );
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
      id: modelCatalogRecordId(
        input.tenantId,
        input.actorId,
        input.provider,
        model.modelId,
      ),
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

/**
 * Returns display-only request metadata. Runtime resolution and every mutation
 * continue to use the exact-owner listModelAssignments contract above.
 */
export async function listModelAssignmentsForRequest(input: {
  tenantId: string;
  actorId: string;
  requestActorBinding?: CanonicalRequestActorBindingV1;
}): Promise<RequestModelAssignment[]> {
  return inTenant(input.tenantId, async () => {
    if (!hasDatabaseUrl()) {
      const ledger = await readLedger();
      const records = ledger.assignments
        .filter((item) =>
          item.tenantId === input.tenantId && item.actorId === input.actorId
        )
        .map((record) => {
          const row = modelAssignmentLedgerRow(record);
          assertRequestModelAssignmentRow(
            row,
            input.tenantId,
            input.actorId,
            input.actorId,
            "ledger",
          );
          return assignmentFromRow(row);
        });
      assertRequestModelAssignmentRecords(
        records,
        input.tenantId,
        input.actorId,
        input.actorId,
      );
      return records
        .sort(compareModelAssignmentRecords)
        .map((record) => requestModelAssignment(record, input.actorId));
    }

    const [canonicalActorId, exactActorId] = modelAssignmentActorReadOrder(
      input.actorId,
      input.requestActorBinding,
    );
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT id, tenant_id, actor_id, scope, provider, model_id,
        fallback_provider, fallback_model_id, allow_cross_provider_fallback,
        runtime_readiness, created_at, updated_at
      FROM omni_model_assignments
      WHERE tenant_id = ${input.tenantId}
        AND actor_id IN (${canonicalActorId}, ${exactActorId})
        AND tenant_id COLLATE "C" = ${input.tenantId}::text COLLATE "C"
        AND (
          actor_id COLLATE "C" = ${canonicalActorId}::text COLLATE "C"
          OR actor_id COLLATE "C" = ${exactActorId}::text COLLATE "C"
        )
      ORDER BY scope COLLATE "C", id COLLATE "C"
    `;
    const records = rows.map((row) => {
      assertRequestModelAssignmentRow(
        row,
        input.tenantId,
        canonicalActorId,
        exactActorId,
      );
      return assignmentFromRow(row);
    });
    assertRequestModelAssignmentRecords(
      records,
      input.tenantId,
      canonicalActorId,
      exactActorId,
    );
    return records.map((record) =>
      requestModelAssignment(record, exactActorId)
    );
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

export async function listServiceApiKeyRecords(input: { tenantId: string; actorId: string }) {
  return inTenant(input.tenantId, async () => {
    if (hasDatabaseUrl()) {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        SELECT * FROM omni_service_api_keys
        WHERE tenant_id = ${input.tenantId} AND actor_id = ${input.actorId}
        ORDER BY created_at DESC, id ASC
      `;
      return rows.map(serviceKeyFromRow);
    }
    const ledger = await readLedger();
    return ledger.apiKeys
      .filter((item) => item.tenantId === input.tenantId && item.actorId === input.actorId)
      .map((item) => effectiveServiceKeyStatus(item));
  });
}

export async function listServiceApiKeyRecordsForRequest(input: {
  tenantId: string;
  actorId: string;
  requestActorBinding?: CanonicalRequestActorBindingV1;
}): Promise<RequestServiceApiKey[]> {
  return inTenant(input.tenantId, async () => {
    if (!hasDatabaseUrl()) {
      const ledger = await readLedger();
      return ledger.apiKeys
        .filter((item) =>
          item.tenantId === input.tenantId && item.actorId === input.actorId
        )
        .map((item) => effectiveServiceKeyStatus(item))
        .map((record) => requestServiceApiKey(record, input.actorId));
    }
    const [canonicalActorId, exactActorId] = serviceApiKeyActorReadOrder(
      input.actorId,
      input.requestActorBinding,
      input.actorId,
    );
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT id, tenant_id, actor_id, name, token_prefix, token_last_four,
        scopes, status, expires_at, last_used_at, revoked_at, created_at,
        updated_at
      FROM omni_service_api_keys
      WHERE tenant_id = ${input.tenantId}
        AND actor_id IN (${canonicalActorId}, ${exactActorId})
        AND tenant_id COLLATE "C" = ${input.tenantId}::text COLLATE "C"
        AND (
          actor_id COLLATE "C" = ${canonicalActorId}::text COLLATE "C"
          OR actor_id COLLATE "C" = ${exactActorId}::text COLLATE "C"
        )
      ORDER BY created_at DESC, id COLLATE "C" ASC
    `;
    const records = rows.map((row) => {
      assertRequestServiceApiKeyRow(row, input.tenantId);
      return redactedServiceKeyFromRow(row);
    });
    assertRequestServiceApiKeyRecords(
      records,
      input.tenantId,
      canonicalActorId,
      exactActorId,
    );
    return records.map((record) => requestServiceApiKey(record, exactActorId));
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

function providerConnectionMetadataFromRow(
  row: Record<string, unknown>,
): RedactedProviderConnection {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    provider: String(row.provider) as SettingsModelProvider,
    label: String(row.label),
    source: "tenant_vault",
    status: String(row.status) as ProviderConnectionStatus,
    enabled: row.enabled as boolean,
    credentialVersion: Number(row.credential_version),
    credentialFingerprint: row.credential_fingerprint
      ? String(row.credential_fingerprint)
      : undefined,
    configuredFields: Array.isArray(row.configured_fields)
      ? row.configured_fields.map(String)
      : [],
    lastValidatedAt: optionalDate(row.last_validated_at),
    validationCode: row.validation_code
      ? String(row.validation_code)
      : undefined,
    catalogRefreshedAt: optionalDate(row.catalog_refreshed_at),
    runtimeReadiness: "active_tenant_runtime",
    runtimeNote:
      "Available to the tenant runtime when assigned to Main agent or Orchestrator. Other saved routing scopes remain configuration-only.",
    createdAt: optionalDate(row.created_at),
    updatedAt: optionalDate(row.updated_at),
    rotatedAt: optionalDate(row.rotated_at),
  };
}

function requestProviderConnection(
  record: RedactedProviderConnection,
  requestActorId: string,
): RequestProviderConnection {
  const manageable = record.source === "tenant_vault" &&
    record.actorId === requestActorId;
  return {
    id: record.id,
    tenantId: record.tenantId,
    actorId: requestActorId,
    provider: record.provider,
    label: safeProviderDisplayText(
      record.label,
      "Unnamed provider connection",
      120,
    ),
    source: record.source,
    status: record.status,
    enabled: record.enabled,
    credentialVersion: record.credentialVersion,
    credentialFingerprint: record.credentialFingerprint,
    configuredFields: [...record.configuredFields],
    lastValidatedAt: record.lastValidatedAt,
    validationCode: record.validationCode
      ? safeProviderDisplayText(record.validationCode, "", 120) || undefined
      : undefined,
    catalogRefreshedAt: record.catalogRefreshedAt,
    runtimeReadiness: manageable
      ? "active_tenant_runtime"
      : "configuration_only",
    runtimeNote: manageable
      ? record.runtimeNote
      : "Retained connection metadata from your stable identity. Read only here; credentials, validation, assignments, and runtime routing remain isolated.",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    rotatedAt: record.rotatedAt,
    manageable,
  };
}

function assertRequestProviderConnectionRow(
  row: Record<string, unknown>,
  expectedTenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  const id = typeof row.id === "string" ? row.id : "";
  const tenantId = typeof row.tenant_id === "string" ? row.tenant_id : "";
  const actorId = typeof row.actor_id === "string" ? row.actor_id : "";
  const provider = typeof row.provider === "string" ? row.provider : "";
  const label = typeof row.label === "string" ? row.label : "";
  const status = typeof row.status === "string" ? row.status : "";
  const configuredFields = row.configured_fields;
  const fingerprint = row.credential_fingerprint;
  const credentialVersion = row.credential_version;
  const providerIsKnown = MODEL_PROVIDERS.includes(
    provider as SettingsModelProvider,
  );
  const statusIsKnown = providerConnectionStatuses.includes(
    status as ProviderConnectionStatus,
  );
  const fieldsAreValid = providerIsKnown &&
    isValidProviderConfiguredFields(
      provider as SettingsModelProvider,
      status as ProviderConnectionStatus,
      configuredFields,
    );
  if (
    !uuidPattern.test(id) ||
    tenantId !== expectedTenantId ||
    (actorId !== canonicalActorId && actorId !== exactActorId) ||
    !providerIsKnown ||
    typeof row.label !== "string" ||
    Array.from(label).length > 120 ||
    !statusIsKnown ||
    typeof row.enabled !== "boolean" ||
    !Number.isSafeInteger(credentialVersion) ||
    Number(credentialVersion) < 1 ||
    !(
      fingerprint === null ||
      fingerprint === undefined ||
      (typeof fingerprint === "string" && /^[0-9a-f]{12}$/.test(fingerprint))
    ) ||
    !fieldsAreValid ||
    (status === "revoked" && (
      row.enabled !== false ||
      fingerprint !== null && fingerprint !== undefined
    )) ||
    !isOptionalText(row.validation_code) ||
    (typeof row.validation_code === "string" &&
      Array.from(row.validation_code).length > 120) ||
    !isOptionalDate(row.last_validated_at) ||
    !isOptionalDate(row.catalog_refreshed_at) ||
    !isRequiredDate(row.created_at) ||
    !isRequiredDate(row.updated_at) ||
    !isOptionalDate(row.rotated_at)
  ) {
    throw new SettingsStoreError(
      "Provider connection metadata could not be resolved safely.",
      409,
    );
  }
}

function assertRequestProviderConnectionRecords(
  records: RedactedProviderConnection[],
  tenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  const ids = new Set<string>();
  const providers = new Set<SettingsModelProvider>();
  for (const record of records) {
    if (
      record.tenantId !== tenantId ||
      (record.actorId !== canonicalActorId && record.actorId !== exactActorId) ||
      ids.has(record.id) ||
      providers.has(record.provider)
    ) {
      throw new SettingsStoreError(
        "Provider connection metadata could not be resolved safely.",
        409,
      );
    }
    ids.add(record.id);
    providers.add(record.provider);
  }
}

function providerConnectionLedgerRow(record: InternalProviderConnection) {
  return {
    id: record.id,
    tenant_id: record.tenantId,
    actor_id: record.actorId,
    provider: record.provider,
    label: record.label,
    status: record.status,
    enabled: record.enabled,
    credential_version: record.credentialVersion,
    credential_fingerprint: record.credentialFingerprint,
    configured_fields: record.configuredFields,
    last_validated_at: record.lastValidatedAt,
    validation_code: record.validationCode,
    catalog_refreshed_at: record.catalogRefreshedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    rotated_at: record.rotatedAt,
  };
}

function isValidProviderConfiguredFields(
  provider: SettingsModelProvider,
  status: ProviderConnectionStatus,
  value: unknown,
) {
  if (!Array.isArray(value) || value.some((field) => typeof field !== "string")) {
    return false;
  }
  const fields = value as string[];
  if (new Set(fields).size !== fields.length) return false;
  if (status === "revoked") return fields.length === 0;
  if (provider !== "aws_bedrock") {
    return fields.length === 1 && fields[0] === "apiKey";
  }
  const allowed = new Set([
    "accessKeyId",
    "secretAccessKey",
    "region",
    "sessionToken",
  ]);
  return fields.every((field) => allowed.has(field)) &&
    fields.includes("accessKeyId") &&
    fields.includes("secretAccessKey") &&
    fields.includes("region");
}

function safeProviderDisplayText(
  value: string,
  fallback: string,
  maxLength: number,
) {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(sanitized || fallback).slice(0, maxLength).join("");
}

function compareProviderConnectionMetadata(
  left: RedactedProviderConnection,
  right: RedactedProviderConnection,
) {
  const updated = (right.updatedAt || "").localeCompare(left.updatedAt || "");
  return updated || left.id.localeCompare(right.id);
}

const providerConnectionStatuses: readonly ProviderConnectionStatus[] = [
  "needs_validation",
  "validating",
  "connected",
  "error",
  "disabled",
  "revoked",
];

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

function requestModelCatalogEntry(
  record: ModelCatalogEntry,
  requestActorId: string,
): RequestModelCatalogEntry {
  const identifierIsSelectable = isSafeModelCatalogIdentifier(record.modelId);
  const displayModelId = identifierIsSelectable
    ? record.modelId
    : safeModelCatalogDisplayText(
        record.modelId,
        "Unsupported model identifier",
        512,
      );
  return {
    id: record.id,
    tenantId: record.tenantId,
    actorId: requestActorId,
    provider: record.provider,
    modelId: record.modelId,
    displayModelId,
    displayName: safeModelCatalogDisplayText(
      record.displayName,
      displayModelId,
      512,
    ),
    capabilities: Array.isArray(record.capabilities)
      ? [...new Set(record.capabilities
        .filter((item): item is string => typeof item === "string")
        .map((item) => safeModelCatalogDisplayText(item, "", 80))
        .filter(Boolean))]
        .slice(0, 32)
      : [],
    lifecycle: record.lifecycle,
    lifecycleReason: record.lifecycleReason
      ? safeModelCatalogDisplayText(record.lifecycleReason, "", 1_000) || undefined
      : undefined,
    lifecycleCheckedAt: record.lifecycleCheckedAt,
    discoveredAt: record.discoveredAt,
    updatedAt: record.updatedAt,
    selectable: record.actorId === requestActorId && identifierIsSelectable,
  };
}

function assertRequestModelCatalogRow(
  row: Record<string, unknown>,
  expectedTenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  const id = typeof row.id === "string" ? row.id : "";
  const tenantId = typeof row.tenant_id === "string" ? row.tenant_id : "";
  const actorId = typeof row.actor_id === "string" ? row.actor_id : "";
  const provider = typeof row.provider === "string" ? row.provider : "";
  const modelId = typeof row.model_id === "string" ? row.model_id : "";
  const capabilities = row.capabilities;
  const lifecycle = typeof row.lifecycle === "string" ? row.lifecycle : "";
  const lifecycleReason = row.lifecycle_reason;
  const providerIsKnown = MODEL_PROVIDERS.includes(
    provider as SettingsModelProvider,
  );
  const lifecycleIsKnown = modelLifecycleStates.includes(
    lifecycle as ModelLifecycleState,
  );
  if (
    !/^[0-9a-f]{64}$/.test(id) ||
    tenantId !== expectedTenantId ||
    (actorId !== canonicalActorId && actorId !== exactActorId) ||
    !providerIsKnown ||
    typeof row.model_id !== "string" ||
    typeof row.display_name !== "string" ||
    !Array.isArray(capabilities) ||
    capabilities.some((capability) =>
      typeof capability !== "string"
    ) ||
    !lifecycleIsKnown ||
    !isOptionalText(lifecycleReason) ||
    !isOptionalDate(row.lifecycle_checked_at) ||
    !isRequiredDate(row.discovered_at) ||
    !isRequiredDate(row.updated_at) ||
    id !== modelCatalogRecordId(
      tenantId,
      actorId,
      provider as SettingsModelProvider,
      modelId,
    )
  ) {
    throw new SettingsStoreError(
      "Model catalog metadata could not be resolved safely.",
      409,
    );
  }
}

function assertRequestModelCatalogRecords(
  records: ModelCatalogEntry[],
  tenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  const ids = new Set<string>();
  const semanticOwners = new Map<string, string>();
  for (const record of records) {
    const semanticKey = `${record.provider}\0${record.modelId}`;
    const priorOwner = semanticOwners.get(semanticKey);
    if (
      record.tenantId !== tenantId ||
      (record.actorId !== canonicalActorId && record.actorId !== exactActorId) ||
      ids.has(record.id) ||
      priorOwner !== undefined
    ) {
      throw new SettingsStoreError(
        "Model catalog metadata could not be resolved safely.",
        409,
      );
    }
    ids.add(record.id);
    semanticOwners.set(semanticKey, record.actorId);
  }
}

const modelLifecycleStates: readonly ModelLifecycleState[] = [
  "available",
  "deprecated",
  "retiring",
  "unknown",
];

function modelCatalogRecordId(
  tenantId: string,
  actorId: string,
  provider: SettingsModelProvider,
  modelId: string,
) {
  return createHash("sha256")
    .update(`${tenantId}\0${actorId}\0${provider}\0${modelId}`)
    .digest("hex");
}

function safeModelCatalogDisplayText(
  value: string,
  fallback: string,
  maxLength: number,
) {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, "�").trim();
  return (sanitized || fallback).slice(0, maxLength);
}

function isSafeModelCatalogIdentifier(value: string) {
  return value.length > 0 &&
    value.length <= 240 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function modelCatalogLedgerRow(record: ModelCatalogEntry) {
  return {
    id: record.id,
    tenant_id: record.tenantId,
    actor_id: record.actorId,
    provider: record.provider,
    model_id: record.modelId,
    display_name: record.displayName,
    capabilities: record.capabilities,
    lifecycle: record.lifecycle,
    lifecycle_reason: record.lifecycleReason,
    lifecycle_checked_at: record.lifecycleCheckedAt,
    discovered_at: record.discoveredAt,
    updated_at: record.updatedAt,
  };
}

function isOptionalText(value: unknown) {
  return value === null ||
    value === undefined ||
    typeof value === "string";
}

function requestModelAssignment(
  record: ModelAssignment,
  requestActorId: string,
): RequestModelAssignment {
  const manageable = record.actorId === requestActorId;
  return {
    id: record.id,
    tenantId: record.tenantId,
    actorId: requestActorId,
    scope: record.scope,
    provider: record.provider,
    modelId: record.modelId,
    displayModelId: safeAssignmentModelIdentifier(record.modelId),
    fallbackProvider: record.fallbackProvider,
    fallbackModelId: record.fallbackModelId,
    displayFallbackModelId: record.fallbackModelId
      ? safeAssignmentModelIdentifier(record.fallbackModelId)
      : undefined,
    allowCrossProviderFallback: record.allowCrossProviderFallback,
    runtimeReadiness: manageable
      ? assignmentRuntimeReadiness(record.scope)
      : "configuration_only",
    runtimeNote: manageable
      ? assignmentRuntimeNote(record.scope)
      : "Compatibility history is visible for review only. This saved route is not active for the current request actor and cannot be managed.",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    manageable,
  };
}

function assertRequestModelAssignmentRow(
  row: Record<string, unknown>,
  expectedTenantId: string,
  canonicalActorId: string,
  exactActorId: string,
  storage: "postgres" | "ledger" = "postgres",
) {
  const id = typeof row.id === "string" ? row.id : "";
  const tenantId = typeof row.tenant_id === "string" ? row.tenant_id : "";
  const actorId = typeof row.actor_id === "string" ? row.actor_id : "";
  const scope = typeof row.scope === "string" ? row.scope : "";
  const provider = typeof row.provider === "string" ? row.provider : "";
  const fallbackProvider = row.fallback_provider;
  const fallbackModelId = row.fallback_model_id;
  const hasNoFallback = fallbackProvider === null && fallbackModelId === null;
  const hasValidFallback = typeof fallbackProvider === "string" &&
    MODEL_PROVIDERS.includes(fallbackProvider as SettingsModelProvider) &&
    isValidAssignmentModelId(fallbackModelId);
  const expectedCrossProviderConsent = hasValidFallback &&
    fallbackProvider !== provider;
  const expectedStoredReadiness = storage === "ledger" &&
      MODEL_ASSIGNMENT_SCOPES.includes(scope as ModelAssignmentScope)
    ? assignmentRuntimeReadiness(scope as ModelAssignmentScope)
    : "configuration_only";
  if (
    !uuidPattern.test(id) ||
    tenantId !== expectedTenantId ||
    (actorId !== canonicalActorId && actorId !== exactActorId) ||
    !MODEL_ASSIGNMENT_SCOPES.includes(scope as ModelAssignmentScope) ||
    !MODEL_PROVIDERS.includes(provider as SettingsModelProvider) ||
    !isValidAssignmentModelId(row.model_id) ||
    (!hasNoFallback && !hasValidFallback) ||
    typeof row.allow_cross_provider_fallback !== "boolean" ||
    row.allow_cross_provider_fallback !== expectedCrossProviderConsent ||
    row.runtime_readiness !== expectedStoredReadiness ||
    !isValidAssignmentDate(row.created_at) ||
    !isValidAssignmentDate(row.updated_at) ||
    assignmentDateMillis(row.created_at) > assignmentDateMillis(row.updated_at)
  ) {
    throw new ModelAssignmentReadConflictError(
      "Model assignment metadata could not be resolved safely.",
    );
  }
}

function assertRequestModelAssignmentRecords(
  records: ModelAssignment[],
  tenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  const ids = new Set<string>();
  const scopes = new Set<ModelAssignmentScope>();
  for (const record of records) {
    if (
      record.tenantId !== tenantId ||
      (record.actorId !== canonicalActorId && record.actorId !== exactActorId) ||
      ids.has(record.id) ||
      scopes.has(record.scope)
    ) {
      throw new ModelAssignmentReadConflictError(
        "Model assignment metadata could not be resolved safely.",
      );
    }
    ids.add(record.id);
    scopes.add(record.scope);
  }
}

function modelAssignmentLedgerRow(record: ModelAssignment) {
  return {
    id: record.id,
    tenant_id: record.tenantId,
    actor_id: record.actorId,
    scope: record.scope,
    provider: record.provider,
    model_id: record.modelId,
    fallback_provider: record.fallbackProvider ?? null,
    fallback_model_id: record.fallbackModelId ?? null,
    allow_cross_provider_fallback: record.allowCrossProviderFallback,
    runtime_readiness: record.runtimeReadiness,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function compareModelAssignmentRecords(
  left: ModelAssignment,
  right: ModelAssignment,
) {
  if (left.scope !== right.scope) return left.scope < right.scope ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function isValidAssignmentModelId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    value.trim() === value;
}

function safeAssignmentModelIdentifier(value: string) {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, "�")
    .trim();
  return Array.from(sanitized || "Unsupported model identifier")
    .slice(0, 240)
    .join("");
}

function isValidAssignmentDate(value: unknown) {
  if (!(typeof value === "string" || value instanceof Date)) return false;
  const parsed = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);
  return !Number.isNaN(parsed.getTime());
}

function assignmentDateMillis(value: unknown) {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
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
  return {
    ...redactedServiceKeyFromRow(row),
    tokenHash: String(row.token_hash),
  };
}

function redactedServiceKeyFromRow(
  row: Record<string, unknown>,
): RedactedServiceApiKey {
  const expiresAt = optionalDate(row.expires_at);
  const storedStatus = String(row.status) as RedactedServiceApiKey["status"];
  return {
    id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id),
    name: String(row.name), tokenPrefix: String(row.token_prefix),
    tokenLastFour: String(row.token_last_four),
    scopes: (Array.isArray(row.scopes) ? row.scopes : []).filter((item): item is ServiceApiScope => SERVICE_API_SCOPES.includes(String(item) as ServiceApiScope)),
    status: storedStatus === "active" && expiresAt && Date.parse(expiresAt) <= Date.now() ? "expired" : storedStatus,
    expiresAt, lastUsedAt: optionalDate(row.last_used_at), createdAt: optionalDate(row.created_at) || new Date().toISOString(),
    updatedAt: optionalDate(row.updated_at) || new Date().toISOString(), revokedAt: optionalDate(row.revoked_at),
  };
}

function effectiveServiceKeyStatus(
  record: InternalServiceApiKey,
): InternalServiceApiKey;
function effectiveServiceKeyStatus(
  record: RedactedServiceApiKey,
): RedactedServiceApiKey;
function effectiveServiceKeyStatus(
  record: RedactedServiceApiKey,
): RedactedServiceApiKey {
  return record.status === "active" && record.expiresAt && Date.parse(record.expiresAt) <= Date.now()
    ? { ...record, status: "expired" }
    : record;
}

function requestServiceApiKey(
  record: RedactedServiceApiKey,
  requestActorId: string,
): RequestServiceApiKey {
  return {
    id: record.id,
    tenantId: record.tenantId,
    actorId: requestActorId,
    name: safeServiceApiKeyDisplayName(record.name),
    tokenPrefix: record.tokenPrefix,
    tokenLastFour: record.tokenLastFour,
    scopes: [...record.scopes],
    status: record.status,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revokedAt: record.revokedAt,
    manageable: record.actorId === requestActorId,
  };
}

function assertRequestServiceApiKeyRow(
  row: Record<string, unknown>,
  expectedTenantId: string,
) {
  const id = String(row.id || "");
  const tenantId = String(row.tenant_id || "");
  const name = String(row.name || "");
  const tokenPrefix = String(row.token_prefix || "");
  const tokenLastFour = String(row.token_last_four || "");
  const scopes = row.scopes;
  const status = String(row.status || "");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ||
    tenantId !== expectedTenantId ||
    !name ||
    name !== name.trim() ||
    name.length > 120 ||
    !isExpectedServiceKeyPreview(tokenPrefix, tenantId, id) ||
    !/^[A-Za-z0-9_-]{4}$/.test(tokenLastFour) ||
    !Array.isArray(scopes) ||
    scopes.length < 1 ||
    scopes.length > SERVICE_API_SCOPES.length ||
    scopes.some((scope) =>
      typeof scope !== "string" ||
      !SERVICE_API_SCOPES.includes(scope as ServiceApiScope)
    ) ||
    new Set(scopes).size !== scopes.length ||
    (status !== "active" && status !== "revoked") ||
    !isRequiredDate(row.created_at) ||
    !isRequiredDate(row.updated_at) ||
    !isOptionalDate(row.expires_at) ||
    !isOptionalDate(row.last_used_at) ||
    !isOptionalDate(row.revoked_at)
  ) {
    throw new SettingsStoreError(
      "Service API key metadata could not be resolved safely.",
      409,
    );
  }
}

function safeServiceApiKeyDisplayName(name: string) {
  const sanitized = name.replace(/[\u0000-\u001f\u007f]/g, "�").trim();
  return sanitized || "Unnamed service key";
}

function isExpectedServiceKeyPreview(
  tokenPrefix: string,
  tenantId: string,
  keyId: string,
) {
  const tenantSegment = Buffer.from(tenantId, "utf8")
    .toString("base64url")
    .slice(0, 10);
  const suffix = keyId.slice(0, 8);
  return tokenPrefix === `asael_sk_${tenantSegment}…${suffix}` ||
    tokenPrefix === `omni_sk_${tenantSegment}…${suffix}`;
}

function assertRequestServiceApiKeyRecords(
  records: RedactedServiceApiKey[],
  tenantId: string,
  canonicalActorId: string,
  exactActorId: string,
) {
  const ids = new Set<string>();
  for (const record of records) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.id) ||
      record.tenantId !== tenantId ||
      (record.actorId !== canonicalActorId && record.actorId !== exactActorId) ||
      ids.has(record.id)
    ) {
      throw new SettingsStoreError(
        "Service API key metadata could not be resolved safely.",
        409,
      );
    }
    ids.add(record.id);
  }
}

function isRequiredDate(value: unknown) {
  return Boolean(value) && Boolean(optionalDate(value));
}

function isOptionalDate(value: unknown) {
  return value === null || value === undefined || Boolean(optionalDate(value));
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
