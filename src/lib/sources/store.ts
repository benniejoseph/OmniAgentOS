import type { getSql } from "@/lib/db/client";
import { retireEntityEvidenceLineage } from "@/lib/entities/store";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  assertExecutionScopeTenant,
  deriveExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import {
  evidenceUnitV1Schema,
  sourceAdapterOutputV1Schema,
  sourceAdapterUpsertV1Schema,
  sourceContractSha256,
  type EvidenceUnitV1,
  type SourceAdapterOutputV1,
  type SourceAdapterUpsertV1,
} from "@/lib/sources/contracts";
import type { CanonicalTextSourceWrite } from "@/lib/sources/text-lineage";

export type SourceSqlClient = ReturnType<typeof getSql>;

export type StoredAdapterEnvelopeRow = Readonly<Record<string, unknown>>;

export type CanonicalSourceLedger = {
  adapterOutputs: SourceAdapterUpsertV1[];
};

export type PersistedKnowledgeLineage = Readonly<{
  sourceItemId: string;
  sourceRevisionId: string;
  evidenceUnitIdsByChunkIndex: readonly string[];
}>;

/** Rebuilds and verifies one immutable canonical evidence contract from storage. */
export function evidenceUnitFromStoredRow(
  row: Readonly<Record<string, unknown>>,
): EvidenceUnitV1 {
  return evidenceUnitV1Schema.parse({
    schemaVersion: Number(row.schema_version),
    contractKind: row.contract_kind,
    evidenceUnitId: row.id,
    tenantId: row.tenant_id,
    ownerActorId: row.owner_actor_id,
    workspaceId: nullableStoredString(row.workspace_id),
    projectId: nullableStoredString(row.project_id),
    missionId: nullableStoredString(row.mission_id),
    connectionId: row.connection_id,
    visibility: row.visibility,
    sensitivity: row.sensitivity,
    permissionGrantIds: storedStringArray(row.permission_grant_ids),
    allowedPurposeIds: storedStringArray(row.allowed_purpose_ids),
    retentionPolicyId: row.retention_policy_id,
    retentionExpiresAt: nullableStoredTimestamp(row.retention_expires_at),
    permissionSetSha256: row.permission_set_sha256,
    purposeSetSha256: row.purpose_set_sha256,
    sourceItemId: row.source_item_id,
    sourceRevisionId: row.source_revision_id,
    sourceKind: row.source_kind,
    providerItemKeySha256: row.provider_item_key_sha256,
    evidenceContentSha256: row.evidence_content_sha256,
    evidenceByteLength: Number(row.evidence_byte_length),
    locator: row.locator,
    locatorSha256: row.locator_sha256,
    sourceCreatedAt: nullableStoredTimestamp(row.source_created_at),
    sourceUpdatedAt: nullableStoredTimestamp(row.source_updated_at),
    capturedAt: requiredStoredTimestamp(row.captured_at),
    extractedAt: requiredStoredTimestamp(row.extracted_at),
    extractorIdentity: {
      extractorId: row.extractor_id,
      extractorVersionId: row.extractor_version_id,
      extractorConfigSha256: row.extractor_config_sha256,
      modelVersionId: nullableStoredString(row.model_version_id),
    },
    evidenceUnitSha256: row.evidence_unit_sha256,
  });
}

export async function persistCanonicalSourceWrite(
  sql: SourceSqlClient,
  write: CanonicalTextSourceWrite,
  options: { documentId: string },
): Promise<PersistedKnowledgeLineage> {
  assertCanonicalSourceTransaction(sql);
  const output = sourceAdapterUpsertV1Schema.parse(write.adapterOutput);
  const executionScope = assertCanonicalWriteScope(write, output);
  const evidenceIndex = canonicalEvidenceIndex(write, output);
  const item = output.sourceItem;
  const revision = output.sourceRevision;
  const extractor = item.extractorIdentity;

  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${item.tenantId}),
      hashtext(${item.sourceItemId})
    )
  `;
  const previousRows = await sql`
    SELECT current_revision_id
    FROM omni_source_items
    WHERE tenant_id = ${item.tenantId}
      AND id = ${item.sourceItemId}
    FOR UPDATE
  `;
  const previousRevisionId = previousRows[0]?.current_revision_id
    ? String(previousRows[0].current_revision_id)
    : null;

  await assertCanonicalAdapterOutputReceipt(sql, output);

  const itemRows = await sql`
    INSERT INTO omni_source_items (
      id, schema_version, contract_kind, tenant_id, owner_actor_id,
      workspace_id, project_id, mission_id, connection_id, visibility,
      sensitivity, permission_grant_ids, allowed_purpose_ids,
      retention_policy_id, retention_expires_at, permission_set_sha256,
      purpose_set_sha256, source_kind, provider_item_key_sha256,
      metadata_sha256, source_created_at, source_updated_at, captured_at,
      extractor_id, extractor_version_id, extractor_config_sha256,
      model_version_id, source_item_sha256, current_revision_id,
      adapter_output_id, adapter_output_sha256, adapter_operation,
      adapter_id, adapter_version_id, adapter_config_sha256,
      adapter_event_key_sha256, adapter_observed_at, created_at, updated_at
    ) VALUES (
      ${item.sourceItemId}, ${item.schemaVersion}, ${item.contractKind},
      ${item.tenantId}, ${item.ownerActorId}, ${item.workspaceId},
      ${item.projectId}, ${item.missionId}, ${item.connectionId},
      ${item.visibility}, ${item.sensitivity}, ${item.permissionGrantIds},
      ${item.allowedPurposeIds}, ${item.retentionPolicyId},
      ${item.retentionExpiresAt}, ${item.permissionSetSha256},
      ${item.purposeSetSha256}, ${item.sourceKind},
      ${item.providerItemKeySha256}, ${item.metadataSha256},
      ${item.sourceCreatedAt}, ${item.sourceUpdatedAt}, ${item.capturedAt},
      ${extractor.extractorId}, ${extractor.extractorVersionId},
      ${extractor.extractorConfigSha256}, ${extractor.modelVersionId},
      ${item.sourceItemSha256}, NULL, ${output.adapterOutputId},
      ${output.adapterOutputSha256}, ${output.operation}, ${output.adapterId},
      ${output.adapterVersionId}, ${output.adapterConfigSha256},
      ${output.adapterEventKeySha256}, ${output.observedAt},
      ${item.capturedAt}, ${item.capturedAt}
    )
    ON CONFLICT (id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      project_id = EXCLUDED.project_id,
      mission_id = EXCLUDED.mission_id,
      visibility = EXCLUDED.visibility,
      sensitivity = EXCLUDED.sensitivity,
      permission_grant_ids = EXCLUDED.permission_grant_ids,
      allowed_purpose_ids = EXCLUDED.allowed_purpose_ids,
      retention_policy_id = EXCLUDED.retention_policy_id,
      retention_expires_at = EXCLUDED.retention_expires_at,
      permission_set_sha256 = EXCLUDED.permission_set_sha256,
      purpose_set_sha256 = EXCLUDED.purpose_set_sha256,
      metadata_sha256 = EXCLUDED.metadata_sha256,
      source_created_at = EXCLUDED.source_created_at,
      source_updated_at = EXCLUDED.source_updated_at,
      captured_at = EXCLUDED.captured_at,
      extractor_id = EXCLUDED.extractor_id,
      extractor_version_id = EXCLUDED.extractor_version_id,
      extractor_config_sha256 = EXCLUDED.extractor_config_sha256,
      model_version_id = EXCLUDED.model_version_id,
      source_item_sha256 = EXCLUDED.source_item_sha256,
      adapter_output_id = EXCLUDED.adapter_output_id,
      adapter_output_sha256 = EXCLUDED.adapter_output_sha256,
      adapter_operation = EXCLUDED.adapter_operation,
      adapter_id = EXCLUDED.adapter_id,
      adapter_version_id = EXCLUDED.adapter_version_id,
      adapter_config_sha256 = EXCLUDED.adapter_config_sha256,
      adapter_event_key_sha256 = EXCLUDED.adapter_event_key_sha256,
      adapter_observed_at = EXCLUDED.adapter_observed_at,
      updated_at = EXCLUDED.updated_at
    WHERE omni_source_items.tenant_id = EXCLUDED.tenant_id
      AND omni_source_items.owner_actor_id = EXCLUDED.owner_actor_id
      AND omni_source_items.connection_id = EXCLUDED.connection_id
      AND omni_source_items.source_kind = EXCLUDED.source_kind
      AND omni_source_items.provider_item_key_sha256 =
        EXCLUDED.provider_item_key_sha256
      AND (
        omni_source_items.current_revision_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM omni_source_revisions current_revision
          WHERE current_revision.tenant_id = omni_source_items.tenant_id
            AND current_revision.id = omni_source_items.current_revision_id
            AND (
              COALESCE(EXCLUDED.source_updated_at, EXCLUDED.captured_at),
              ${revision.sourceRevisionId}
            ) >= (
              COALESCE(
                current_revision.source_updated_at,
                current_revision.captured_at
              ),
              current_revision.id
            )
        )
      )
    RETURNING id
  `;
  if (itemRows.length !== 1) {
    throw new Error(
      "Canonical source item conflicts with an existing identity or newer revision.",
    );
  }

  const revisionExtractor = revision.extractorIdentity;
  const insertedRevision = await sql`
    INSERT INTO omni_source_revisions (
      id, schema_version, contract_kind, tenant_id, source_item_id,
      previous_source_revision_id, owner_actor_id, workspace_id, project_id,
      mission_id, connection_id, visibility, sensitivity,
      permission_grant_ids, allowed_purpose_ids, retention_policy_id,
      retention_expires_at, permission_set_sha256, purpose_set_sha256,
      source_kind, provider_item_key_sha256, provider_revision_key_sha256,
      content_sha256, content_byte_length, media_type, metadata_sha256,
      source_created_at, source_updated_at, captured_at, extractor_id,
      extractor_version_id, extractor_config_sha256, model_version_id,
      source_revision_sha256, adapter_output_id, adapter_output_sha256,
      adapter_operation, adapter_id, adapter_version_id,
      adapter_config_sha256, adapter_event_key_sha256, adapter_observed_at,
      created_at
    ) VALUES (
      ${revision.sourceRevisionId}, ${revision.schemaVersion},
      ${revision.contractKind}, ${revision.tenantId}, ${revision.sourceItemId},
      ${revision.previousSourceRevisionId}, ${revision.ownerActorId},
      ${revision.workspaceId}, ${revision.projectId}, ${revision.missionId},
      ${revision.connectionId}, ${revision.visibility}, ${revision.sensitivity},
      ${revision.permissionGrantIds}, ${revision.allowedPurposeIds},
      ${revision.retentionPolicyId}, ${revision.retentionExpiresAt},
      ${revision.permissionSetSha256}, ${revision.purposeSetSha256},
      ${revision.sourceKind}, ${revision.providerItemKeySha256},
      ${revision.providerRevisionKeySha256}, ${revision.contentSha256},
      ${revision.contentByteLength}, ${revision.mediaType},
      ${revision.metadataSha256}, ${revision.sourceCreatedAt},
      ${revision.sourceUpdatedAt}, ${revision.capturedAt},
      ${revisionExtractor.extractorId},
      ${revisionExtractor.extractorVersionId},
      ${revisionExtractor.extractorConfigSha256},
      ${revisionExtractor.modelVersionId}, ${revision.sourceRevisionSha256},
      ${output.adapterOutputId}, ${output.adapterOutputSha256},
      ${output.operation}, ${output.adapterId}, ${output.adapterVersionId},
      ${output.adapterConfigSha256}, ${output.adapterEventKeySha256},
      ${output.observedAt}, ${revision.capturedAt}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  if (!insertedRevision.length) {
    const existing = await sql`
      SELECT
        source_revision_sha256,
        tenant_id,
        connection_id,
        adapter_output_id,
        adapter_output_sha256,
        adapter_operation,
        adapter_id,
        adapter_version_id,
        adapter_config_sha256,
        adapter_event_key_sha256,
        adapter_observed_at
      FROM omni_source_revisions
      WHERE tenant_id = ${revision.tenantId}
        AND id = ${revision.sourceRevisionId}
      LIMIT 1
    `;
    if (
      existing.length !== 1 ||
      existing[0].source_revision_sha256 !== revision.sourceRevisionSha256 ||
      !storedAdapterEnvelopeMatches(existing[0], output)
    ) {
      throw new Error(
        "Canonical source revision ID is already bound to different immutable data.",
      );
    }
  }

  if (output.evidenceUnits.length) {
    const payload = output.evidenceUnits.map((evidence) => {
      const evidenceExtractor = evidence.extractorIdentity;
      return {
        id: evidence.evidenceUnitId,
        schema_version: evidence.schemaVersion,
        contract_kind: evidence.contractKind,
        tenant_id: evidence.tenantId,
        source_item_id: evidence.sourceItemId,
        source_revision_id: evidence.sourceRevisionId,
        owner_actor_id: evidence.ownerActorId,
        workspace_id: evidence.workspaceId,
        project_id: evidence.projectId,
        mission_id: evidence.missionId,
        connection_id: evidence.connectionId,
        visibility: evidence.visibility,
        sensitivity: evidence.sensitivity,
        permission_grant_ids: evidence.permissionGrantIds,
        allowed_purpose_ids: evidence.allowedPurposeIds,
        retention_policy_id: evidence.retentionPolicyId,
        retention_expires_at: evidence.retentionExpiresAt,
        permission_set_sha256: evidence.permissionSetSha256,
        purpose_set_sha256: evidence.purposeSetSha256,
        source_kind: evidence.sourceKind,
        provider_item_key_sha256: evidence.providerItemKeySha256,
        evidence_content_sha256: evidence.evidenceContentSha256,
        evidence_byte_length: evidence.evidenceByteLength,
        locator: evidence.locator,
        locator_sha256: evidence.locatorSha256,
        source_created_at: evidence.sourceCreatedAt,
        source_updated_at: evidence.sourceUpdatedAt,
        captured_at: evidence.capturedAt,
        extracted_at: evidence.extractedAt,
        extractor_id: evidenceExtractor.extractorId,
        extractor_version_id: evidenceExtractor.extractorVersionId,
        extractor_config_sha256: evidenceExtractor.extractorConfigSha256,
        model_version_id: evidenceExtractor.modelVersionId,
        evidence_unit_sha256: evidence.evidenceUnitSha256,
        adapter_output_id: output.adapterOutputId,
        adapter_output_sha256: output.adapterOutputSha256,
        adapter_operation: output.operation,
        adapter_id: output.adapterId,
        adapter_version_id: output.adapterVersionId,
        adapter_config_sha256: output.adapterConfigSha256,
        adapter_event_key_sha256: output.adapterEventKeySha256,
        adapter_observed_at: output.observedAt,
        created_at: evidence.extractedAt,
      };
    });
    await sql`
      INSERT INTO omni_evidence_units (
        id, schema_version, contract_kind, tenant_id, source_item_id,
        source_revision_id, owner_actor_id, workspace_id, project_id,
        mission_id, connection_id, visibility, sensitivity,
        permission_grant_ids, allowed_purpose_ids, retention_policy_id,
        retention_expires_at, permission_set_sha256, purpose_set_sha256,
        source_kind, provider_item_key_sha256, evidence_content_sha256,
        evidence_byte_length, locator, locator_sha256, source_created_at,
        source_updated_at, captured_at, extracted_at, extractor_id,
        extractor_version_id, extractor_config_sha256, model_version_id,
        evidence_unit_sha256, adapter_output_id, adapter_output_sha256,
        adapter_operation, adapter_id, adapter_version_id,
        adapter_config_sha256, adapter_event_key_sha256, adapter_observed_at,
        created_at
      )
      SELECT
        id, schema_version, contract_kind, tenant_id, source_item_id,
        source_revision_id, owner_actor_id, workspace_id, project_id,
        mission_id, connection_id, visibility, sensitivity,
        permission_grant_ids, allowed_purpose_ids, retention_policy_id,
        retention_expires_at, permission_set_sha256, purpose_set_sha256,
        source_kind, provider_item_key_sha256, evidence_content_sha256,
        evidence_byte_length, locator, locator_sha256, source_created_at,
        source_updated_at, captured_at, extracted_at, extractor_id,
        extractor_version_id, extractor_config_sha256, model_version_id,
        evidence_unit_sha256, adapter_output_id, adapter_output_sha256,
        adapter_operation, adapter_id, adapter_version_id,
        adapter_config_sha256, adapter_event_key_sha256, adapter_observed_at,
        created_at
      FROM jsonb_to_recordset(${payload}::jsonb) AS input(
        id text, schema_version integer, contract_kind text, tenant_id text,
        source_item_id text, source_revision_id text, owner_actor_id text,
        workspace_id text, project_id text, mission_id text,
        connection_id text, visibility text, sensitivity text,
        permission_grant_ids text[], allowed_purpose_ids text[],
        retention_policy_id text, retention_expires_at timestamptz,
        permission_set_sha256 text, purpose_set_sha256 text,
        source_kind text, provider_item_key_sha256 text,
        evidence_content_sha256 text, evidence_byte_length bigint,
        locator jsonb, locator_sha256 text, source_created_at timestamptz,
        source_updated_at timestamptz, captured_at timestamptz,
        extracted_at timestamptz, extractor_id text,
        extractor_version_id text, extractor_config_sha256 text,
        model_version_id text, evidence_unit_sha256 text,
        adapter_output_id text, adapter_output_sha256 text,
        adapter_operation text, adapter_id text, adapter_version_id text,
        adapter_config_sha256 text, adapter_event_key_sha256 text,
        adapter_observed_at timestamptz, created_at timestamptz
      )
      ON CONFLICT (id) DO NOTHING
    `;

    const evidenceIds = [...evidenceIndex.keys()];
    const persistedEvidence = await sql`
      SELECT
        id,
        evidence_unit_sha256,
        tenant_id,
        connection_id,
        adapter_output_id,
        adapter_output_sha256,
        adapter_operation,
        adapter_id,
        adapter_version_id,
        adapter_config_sha256,
        adapter_event_key_sha256,
        adapter_observed_at
      FROM omni_evidence_units
      WHERE tenant_id = ${item.tenantId}
        AND source_revision_id = ${revision.sourceRevisionId}
        AND id = ANY(${evidenceIds})
    `;
    const persistedById = new Map(
      persistedEvidence.map((row) => [String(row.id), row]),
    );
    for (const evidence of output.evidenceUnits) {
      const persisted = persistedById.get(evidence.evidenceUnitId);
      if (
        !persisted ||
        persisted.evidence_unit_sha256 !== evidence.evidenceUnitSha256 ||
        !storedAdapterEnvelopeMatches(persisted, output)
      ) {
        throw new Error(
          "Canonical evidence unit ID is already bound to different immutable data.",
        );
      }
    }
  }

  if (
    previousRevisionId &&
    previousRevisionId !== revision.sourceRevisionId
  ) {
    await retireEntityLineageForSourceRevision(sql, {
      tenantId: item.tenantId,
      ownerActorId: item.ownerActorId,
      sourceRevisionId: previousRevisionId,
      executionScope,
      retiredAt: output.observedAt,
    });
  }

  const currentRows = await sql`
    UPDATE omni_source_items
    SET current_revision_id = ${revision.sourceRevisionId},
        updated_at = ${output.observedAt}
    WHERE tenant_id = ${item.tenantId}
      AND id = ${item.sourceItemId}
    RETURNING id
  `;
  if (currentRows.length !== 1) {
    throw new Error("Canonical source current-revision projection was not updated.");
  }

  await appendScopedDomainEvent({
    streamId: `source:${item.sourceItemId}`,
    type: "source.revision.shadow_indexed",
    executionScope,
    payload: {
      schemaVersion: 1,
      documentId: options.documentId,
      sourceItemId: item.sourceItemId,
      sourceRevisionId: revision.sourceRevisionId,
      sourceItemSha256: item.sourceItemSha256,
      sourceRevisionSha256: revision.sourceRevisionSha256,
      adapterOutputId: output.adapterOutputId,
      adapterOutputSha256: output.adapterOutputSha256,
      connectionId: item.connectionId,
      adapterId: output.adapterId,
      evidenceUnitCount: output.evidenceUnits.length,
      evidenceUnitSetSha256: sourceContractSha256(
        output.evidenceUnits.map((evidence) => evidence.evidenceUnitId),
      ),
    },
  }, { sql });

  return {
    sourceItemId: item.sourceItemId,
    sourceRevisionId: revision.sourceRevisionId,
    evidenceUnitIdsByChunkIndex: write.evidenceUnitIdsByChunkIndex,
  };
}

export async function retireEntityLineageForSourceRevision(
  sql: SourceSqlClient,
  input: {
    tenantId: string;
    ownerActorId: string;
    sourceRevisionId: string;
    executionScope: ExecutionScope;
    retiredAt?: string;
  },
) {
  assertCanonicalSourceTransaction(sql);
  const rows = await sql`
    SELECT id
    FROM omni_evidence_units
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
      AND source_revision_id = ${input.sourceRevisionId}
    ORDER BY id COLLATE "C"
  `;
  const evidenceUnitIds = rows.map((row) => String(row.id));
  if (!evidenceUnitIds.length) {
    return Object.freeze({
      affectedEntityIds: Object.freeze([] as string[]),
      retiredEntityIds: Object.freeze([] as string[]),
      retiredAliasIds: Object.freeze([] as string[]),
    });
  }
  const referenced = await sql`
    SELECT 1
    FROM omni_entity_records
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
      AND lineage_evidence_unit_ids && ${evidenceUnitIds}::TEXT[]
    UNION ALL
    SELECT 1
    FROM omni_entity_aliases
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
      AND lineage_evidence_unit_ids && ${evidenceUnitIds}::TEXT[]
    LIMIT 1
  `;
  if (!referenced.length) {
    return Object.freeze({
      affectedEntityIds: Object.freeze([] as string[]),
      retiredEntityIds: Object.freeze([] as string[]),
      retiredAliasIds: Object.freeze([] as string[]),
    });
  }
  return retireEntityEvidenceLineage({
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    evidenceUnitIds,
    executionScope: deriveExecutionScope(input.executionScope, {
      purpose: "entity.source.lifecycle.v1",
    }),
    retiredAt: input.retiredAt,
    sql,
  });
}

/**
 * Claims the tenant-scoped adapter-output identity and locks its immutable
 * receipt before any source projection or lineage row can be changed.
 * The supplied SQL client must belong to the caller's existing transaction.
 */
export async function assertCanonicalAdapterOutputReceipt(
  sql: SourceSqlClient,
  output: SourceAdapterOutputV1,
) {
  assertCanonicalSourceTransaction(sql);
  sourceAdapterOutputV1Schema.parse(output);
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${output.tenantId}),
      hashtext(${output.adapterOutputId})
    )
  `;

  await sql`
    INSERT INTO omni_source_adapter_output_receipts (
      schema_version,
      contract_kind,
      tenant_id,
      connection_id,
      adapter_output_id,
      adapter_output_sha256,
      adapter_operation,
      adapter_id,
      adapter_version_id,
      adapter_config_sha256,
      adapter_event_key_sha256,
      adapter_observed_at
    ) VALUES (
      ${output.schemaVersion},
      ${output.contractKind},
      ${output.tenantId},
      ${output.connectionId},
      ${output.adapterOutputId},
      ${output.adapterOutputSha256},
      ${output.operation},
      ${output.adapterId},
      ${output.adapterVersionId},
      ${output.adapterConfigSha256},
      ${output.adapterEventKeySha256},
      ${output.observedAt}
    )
    ON CONFLICT (tenant_id, adapter_output_id) DO NOTHING
  `;

  const receipts = await sql`
    SELECT
      schema_version,
      contract_kind,
      tenant_id,
      connection_id,
      adapter_output_id,
      adapter_output_sha256,
      adapter_operation,
      adapter_id,
      adapter_version_id,
      adapter_config_sha256,
      adapter_event_key_sha256,
      adapter_observed_at
    FROM omni_source_adapter_output_receipts
    WHERE tenant_id = ${output.tenantId}
      AND adapter_output_id = ${output.adapterOutputId}
  `;
  const receipt = receipts[0];
  if (
    receipts.length !== 1 ||
    Number(receipt.schema_version) !== output.schemaVersion ||
    receipt.contract_kind !== output.contractKind ||
    !storedAdapterEnvelopeMatches(receipt, output)
  ) {
    throw new Error(
      "Canonical adapter output ID is already bound to a different immutable receipt.",
    );
  }
}

function assertCanonicalSourceTransaction(sql: SourceSqlClient) {
  if (!sql.transactionScoped) {
    throw new Error(
      "Canonical source persistence requires an existing database transaction.",
    );
  }
}

export function storedAdapterEnvelopeMatches(
  row: StoredAdapterEnvelopeRow,
  output: SourceAdapterOutputV1,
) {
  return row.tenant_id === output.tenantId &&
    row.connection_id === output.connectionId &&
    row.adapter_output_id === output.adapterOutputId &&
    row.adapter_output_sha256 === output.adapterOutputSha256 &&
    row.adapter_operation === output.operation &&
    row.adapter_id === output.adapterId &&
    row.adapter_version_id === output.adapterVersionId &&
    row.adapter_config_sha256 === output.adapterConfigSha256 &&
    row.adapter_event_key_sha256 === output.adapterEventKeySha256 &&
    canonicalStoredTimestamp(row.adapter_observed_at) === output.observedAt;
}

export function mergeCanonicalSourceLedger(
  ledger: CanonicalSourceLedger | undefined,
  write: CanonicalTextSourceWrite,
) {
  const output = sourceAdapterUpsertV1Schema.parse(write.adapterOutput);
  assertCanonicalWriteScope(write, output);
  canonicalEvidenceIndex(write, output);
  const current = ledger?.adapterOutputs || [];
  const existing = current.find(
    (item) => item.adapterOutputId === output.adapterOutputId,
  );
  if (
    existing &&
    existing.adapterOutputSha256 !== output.adapterOutputSha256
  ) {
    throw new Error(
      "Canonical adapter output ID is already bound to different data.",
    );
  }
  return {
    adapterOutputs: existing
      ? current
      : [output, ...current].slice(0, 5_000),
  } satisfies CanonicalSourceLedger;
}

function assertCanonicalWriteScope(
  write: CanonicalTextSourceWrite,
  output: SourceAdapterUpsertV1,
) {
  const scope = parsePersistedExecutionScope(write.executionScope);
  if (!scope?.initiatingActorId) {
    throw new Error("Canonical source writes require an initiating actor.");
  }
  assertExecutionScopeTenant(scope, output.tenantId);
  if (
    scope.initiatingActorId !== output.ownerActorId ||
    scope.workspaceId !== output.workspaceId ||
    scope.projectId !== output.projectId ||
    scope.missionId !== output.missionId
  ) {
    throw new Error(
      "Canonical source write does not match its execution scope.",
    );
  }
  return scope;
}

function canonicalEvidenceIndex(
  write: CanonicalTextSourceWrite,
  output: SourceAdapterUpsertV1,
) {
  if (
    write.evidenceUnitIdsByChunkIndex.length !== output.evidenceUnits.length
  ) {
    throw new Error("Canonical source write must map every evidence unit once.");
  }
  const evidenceById = new Map(
    output.evidenceUnits.map((evidence) => [evidence.evidenceUnitId, evidence]),
  );
  const index = new Map<string, number>();
  write.evidenceUnitIdsByChunkIndex.forEach((evidenceUnitId, chunkIndex) => {
    if (!evidenceById.has(evidenceUnitId) || index.has(evidenceUnitId)) {
      throw new Error(
        "Canonical source write contains an invalid chunk-to-evidence mapping.",
      );
    }
    index.set(evidenceUnitId, chunkIndex);
  });
  return index;
}

function canonicalStoredTimestamp(value: unknown) {
  if (!(value instanceof Date) && typeof value !== "string") {
    return null;
  }
  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function nullableStoredTimestamp(value: unknown) {
  if (value === null || value === undefined) return null;
  return canonicalStoredTimestamp(value);
}

function requiredStoredTimestamp(value: unknown) {
  const timestamp = canonicalStoredTimestamp(value);
  if (!timestamp) throw new Error("Stored evidence timestamp is invalid.");
  return timestamp;
}

function nullableStoredString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function storedStringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : value;
}
