import { randomUUID } from "node:crypto";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import {
  buildRelationProjectionPlan,
  type RelationProjectionSource,
} from "@/lib/entities/relation-projection";
import { reconcileTemporalRelationClaimProjection } from "@/lib/entities/temporal-claim-store";
import {
  buildEntityAccessBinding,
  ENTITY_PURPOSE_IDS,
  parseEntityAlias,
  parseEntityRecord,
} from "@/lib/entities/registry";
import { ASAEL_ONTOLOGY_EFFECTIVE_AT } from "@/lib/entities/ontology";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { CLAIM_EVIDENCE_PURPOSE_ID } from "@/lib/sources/purposes";
import { sourceContractSha256 } from "@/lib/sources/contracts";

type RelationProjectorSqlClient = ReturnType<typeof getSql>;

export type TemporalRelationProjectionReport = Readonly<{
  tenantId: string;
  ownerActorId: string;
  projectionSha256: string;
  stateSha256: string;
  sourceCount: number;
  markerCount: number;
  rejectedMarkerCount: number;
  unresolvedMarkerCount: number;
  activeClaimCount: number;
  createdCount: number;
  revisedCount: number;
  retractedCount: number;
  unchangedCount: number;
}>;

/**
 * Rebuilds one actor's typed relation projection from canonical storage in a
 * single serializable transaction. Queue repair and explicit full rebuilds
 * call this same function.
 */
export async function rebuildTemporalRelationProjection(input: {
  tenantId: string;
  ownerActorId: string;
  correlationId?: string;
  sql?: RelationProjectorSqlClient;
}): Promise<TemporalRelationProjectionReport> {
  const tenantId = canonicalId(input.tenantId, "tenant");
  const ownerActorId = canonicalId(input.ownerActorId, "owner actor");
  if (!hasDatabaseUrl() && !input.sql) {
    throw new Error(
      "Canonical relation projection rebuild requires database storage.",
    );
  }
  if (!input.sql) await ensureDatabaseSchema();
  const executionScope = createExecutionScope({
    tenantId,
    initiatingActorId: ownerActorId,
    executingPrincipalType: "system",
    executingPrincipalId: "entity-relation-projector",
    correlationId:
      input.correlationId?.trim().slice(0, 256) ||
      `entity_relation_projection_${randomUUID()}`,
    purpose: "entity.relation.project.v1",
  });

  const operation = async (sql: RelationProjectorSqlClient) => {
    await sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${tenantId}),
        hashtext(${`entity-relations:${ownerActorId}`})
      )
    `;
    const [memoryRows, evidenceRows, entityRows, aliasRows] = await Promise.all([
      readCanonicalMemorySources(sql, tenantId, ownerActorId),
      readCanonicalEvidenceSources(sql, tenantId, ownerActorId),
      sql`
        SELECT contract
        FROM omni_entity_records
        WHERE tenant_id = ${tenantId}
          AND owner_actor_id = ${ownerActorId}
          AND state = 'active'
        ORDER BY id COLLATE "C"
      `,
      sql`
        SELECT contract
        FROM omni_entity_aliases
        WHERE tenant_id = ${tenantId}
          AND owner_actor_id = ${ownerActorId}
          AND state = 'active'
        ORDER BY id COLLATE "C"
      `,
    ]);
    const plan = buildRelationProjectionPlan({
      sources: [
        ...memoryRows.map(memoryProjectionSource),
        ...deduplicateEvidenceSources(
          evidenceRows.map(evidenceProjectionSource),
        ),
      ],
      entities: entityRows.map((row) => parseEntityRecord(row.contract)),
      aliases: aliasRows.map((row) => parseEntityAlias(row.contract)),
    });
    const reconciliation = await reconcileTemporalRelationClaimProjection({
      tenantId,
      ownerActorId,
      desiredClaims: plan.desiredClaims,
      projectionSha256: plan.projectionSha256,
      executionScope,
      reconciledAt: new Date().toISOString(),
      sql,
    });
    return Object.freeze({
      tenantId,
      ownerActorId,
      projectionSha256: plan.projectionSha256,
      stateSha256: reconciliation.stateSha256,
      sourceCount: plan.sourceCount,
      markerCount: plan.markerCount,
      rejectedMarkerCount: plan.rejectedMarkerCount,
      unresolvedMarkerCount: plan.unresolvedMarkerCount,
      activeClaimCount: reconciliation.activeClaims.length,
      createdCount: reconciliation.createdCount,
      revisedCount: reconciliation.revisedCount,
      retractedCount: reconciliation.retractedCount,
      unchangedCount: reconciliation.unchangedCount,
    });
  };

  if (input.sql) return operation(input.sql);
  return runWithDatabaseSystemScope(
    "Rebuild an actor-owned temporal relation projection from canonical claims and evidence.",
    () => getSql().transaction(operation) as Promise<TemporalRelationProjectionReport>,
  );
}

function readCanonicalMemorySources(
  sql: RelationProjectorSqlClient,
  tenantId: string,
  ownerActorId: string,
) {
  return sql`
    SELECT
      id, tenant_id, owner_actor_id, access_scope_sha256, sensitivity,
      source, content, confidence, valid_from, valid_to, created_at, updated_at
    FROM omni_memories
    WHERE tenant_id = ${tenantId}
      AND owner_actor_id = ${ownerActorId}
      AND access_contract_version = 1
      AND access_state = 'scope_bound'
      AND visibility = 'user_private'
      AND owner_agent_id IS NULL
      AND workspace_id IS NULL
      AND project_id IS NULL
      AND mission_id IS NULL
      AND claim_status = 'active'
      AND asserted_by = 'user'
      AND (
        source IN ('manual', 'user-assertion')
        OR source LIKE 'correction:%'
        OR (
          source LIKE 'cognify-reviewed:%'
          AND formation_reason = 'source_cognition'
          AND EXISTS (
            SELECT 1 FROM unnest(evidence_refs) reference
            WHERE reference LIKE 'cognition-review:%'
          )
          AND EXISTS (
            SELECT 1 FROM unnest(evidence_refs) reference
            WHERE reference LIKE 'knowledge:%'
          )
          AND EXISTS (
            SELECT 1 FROM unnest(evidence_refs) reference
            WHERE reference LIKE 'evidence:%'
          )
        )
      )
      AND btrim(content) <> ''
      AND (retention_expires_at IS NULL OR retention_expires_at > NOW())
    ORDER BY id COLLATE "C"
  `;
}

function readCanonicalEvidenceSources(
  sql: RelationProjectorSqlClient,
  tenantId: string,
  ownerActorId: string,
) {
  return sql`
    SELECT
      evidence.id, evidence.tenant_id, evidence.owner_actor_id,
      evidence.evidence_unit_sha256, evidence.sensitivity,
      evidence.source_created_at, evidence.source_updated_at,
      evidence.captured_at, evidence.extracted_at, chunk.content
    FROM omni_source_items item
    JOIN omni_evidence_units evidence
      ON evidence.tenant_id = item.tenant_id
     AND evidence.source_item_id = item.id
     AND evidence.source_revision_id = item.current_revision_id
    JOIN omni_knowledge_chunks chunk
      ON chunk.tenant_id = evidence.tenant_id
     AND chunk.evidence_unit_id = evidence.id
     AND chunk.source_revision_id = evidence.source_revision_id
    WHERE item.tenant_id = ${tenantId}
      AND item.owner_actor_id = ${ownerActorId}
      AND item.visibility = 'user_private'
      AND item.workspace_id IS NULL
      AND item.project_id IS NULL
      AND item.mission_id IS NULL
      AND ${CLAIM_EVIDENCE_PURPOSE_ID} = ANY(item.allowed_purpose_ids)
      AND ${CLAIM_EVIDENCE_PURPOSE_ID} = ANY(evidence.allowed_purpose_ids)
      AND (item.retention_expires_at IS NULL OR item.retention_expires_at > NOW())
      AND (evidence.retention_expires_at IS NULL OR evidence.retention_expires_at > NOW())
    ORDER BY evidence.id COLLATE "C", chunk.chunk_index
  `;
}

function memoryProjectionSource(
  row: Record<string, unknown>,
): RelationProjectionSource {
  const tenantId = String(row.tenant_id);
  const ownerActorId = String(row.owner_actor_id);
  const updatedAt = timestamp(row.updated_at);
  return Object.freeze({
    sourceKind: "memory",
    sourceId: String(row.id),
    sourceSha256: sourceContractSha256({
      memoryId: row.id,
      tenantId,
      ownerActorId,
      accessScopeSha256: row.access_scope_sha256,
      contentSha256: sourceContractSha256(String(row.content || "")),
      updatedAt,
    }),
    content: String(row.content || ""),
    accessBinding: buildEntityAccessBinding({
      tenantId,
      ownerActorId,
      visibility: "user_private",
      sensitivity: sensitivity(row.sensitivity),
      allowedPurposeIds: ENTITY_PURPOSE_IDS,
      boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
    }),
    epistemicKind: String(row.source || "").startsWith("cognify-reviewed:")
      ? "inferred"
      : "asserted",
    confidenceBasisPoints: Math.round(
      Math.min(Math.max(Number(row.confidence ?? 0.95), 0), 1) * 10_000,
    ),
    defaultValidFrom: timestamp(row.valid_from || row.created_at),
    defaultValidTo: row.valid_to ? timestamp(row.valid_to) : null,
    recordedAt: updatedAt,
  });
}

function evidenceProjectionSource(
  row: Record<string, unknown>,
): RelationProjectionSource {
  const sourceTime = timestamp(
    row.source_updated_at || row.source_created_at || row.captured_at,
  );
  return Object.freeze({
    sourceKind: "evidence_unit",
    sourceId: String(row.id),
    sourceSha256: String(row.evidence_unit_sha256),
    content: String(row.content || ""),
    accessBinding: buildEntityAccessBinding({
      tenantId: String(row.tenant_id || ""),
      ownerActorId: String(row.owner_actor_id || ""),
      visibility: "user_private",
      sensitivity: sensitivity(row.sensitivity),
      allowedPurposeIds: ENTITY_PURPOSE_IDS,
      boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
    }),
    epistemicKind: "observed",
    confidenceBasisPoints: 10_000,
    defaultValidFrom: sourceTime,
    defaultValidTo: null,
    recordedAt: timestamp(row.extracted_at),
  });
}

function deduplicateEvidenceSources(
  sources: readonly RelationProjectionSource[],
) {
  const byId = new Map<string, RelationProjectionSource>();
  for (const source of sources) {
    const existing = byId.get(source.sourceId);
    if (existing && sourceContractSha256(existing) !== sourceContractSha256(source)) {
      throw new Error(
        "Canonical evidence unit is bound to conflicting projection content.",
      );
    }
    byId.set(source.sourceId, source);
  }
  return [...byId.values()].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
  );
}

function sensitivity(value: unknown) {
  const parsed = String(value || "confidential");
  if (
    parsed !== "public" &&
    parsed !== "internal" &&
    parsed !== "confidential" &&
    parsed !== "restricted"
  ) {
    throw new Error("Canonical projection sensitivity is invalid.");
  }
  return parsed;
}

function timestamp(value: unknown) {
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Canonical projection timestamp is invalid.");
  }
  return parsed.toISOString();
}

function canonicalId(value: string, label: string) {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(normalized)
  ) {
    throw new Error(`Relation projection ${label} ID is invalid.`);
  }
  return normalized;
}
