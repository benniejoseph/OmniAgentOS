import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  buildUserPrivateMemoryAccessBindingV1,
  MEMORY_PURPOSE_IDS,
} from "@/lib/memory/access-binding";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

type MemorySqlClient = ReturnType<typeof getSql>;

type LegacyMemoryRow = Readonly<{
  id: string;
  claimStatus: string;
  updatedAt: string;
}>;

export type LegacyMemoryOwnershipPreview = Readonly<{
  version: 1;
  count: number;
  activeCount: number;
  historicalCount: number;
  manifestSha256: string;
}>;

export type LegacyMemoryOwnershipMigration = Readonly<{
  preview: LegacyMemoryOwnershipPreview;
  migratedCount: number;
  reviewCount: number;
  traceCount: number;
  removedGraphNodeCount: number;
  removedGraphEdgeCount: number;
  recordIds: readonly string[];
}>;

const DURABLE_FORMATION_REASONS = Object.freeze([
  "manual_user_entry",
  "explicit_user_request",
  "correction",
  "project_reflection",
  "project_artifact",
  "workflow_output",
  "maintenance_promotion",
]);

export async function previewLegacyDurableMemoryOwnership(input: {
  tenantId: string;
}): Promise<LegacyMemoryOwnershipPreview> {
  if (!hasDatabaseUrl()) return ownershipPreview(input.tenantId, []);
  await ensureDatabaseSchema();
  return runWithDatabaseTenantScope(input.tenantId, async () =>
    ownershipPreview(
      input.tenantId,
      await selectLegacyDurableRows(getSql(), input.tenantId),
    )
  );
}

export async function migrateLegacyDurableMemoryOwnership(input: {
  tenantId: string;
  ownerActorId: string;
  expectedManifestSha256: string;
  executionScope: ExecutionScope;
  migratedAt?: string;
}): Promise<LegacyMemoryOwnershipMigration> {
  if (!hasDatabaseUrl()) {
    throw new Error("Legacy memory ownership migration requires database storage.");
  }
  const scope = parsePersistedExecutionScope(input.executionScope);
  if (
    !scope ||
    scope.tenantId !== input.tenantId ||
    scope.initiatingActorId !== input.ownerActorId ||
    scope.executingPrincipalType !== "user" ||
    scope.executingPrincipalId !== input.ownerActorId ||
    scope.workspaceId !== null ||
    scope.projectId !== null ||
    scope.missionId !== null
  ) {
    throw new Error("Legacy memory ownership migration requires the exact user owner scope.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.expectedManifestSha256)) {
    throw new Error("Legacy memory ownership preview digest is invalid.");
  }
  const migratedAt = new Date(input.migratedAt || Date.now()).toISOString();
  const memoryBinding = buildUserPrivateMemoryAccessBindingV1({
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    originPurpose: "memory.legacy_owner_enrollment",
    accessBoundAt: migratedAt,
  });
  const traceBinding = buildUserPrivateMemoryAccessBindingV1({
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    originPurpose: "context.retrieval.trace",
    allowedPurposeIds: [
      MEMORY_PURPOSE_IDS.export,
      MEMORY_PURPOSE_IDS.forget,
      MEMORY_PURPOSE_IDS.read,
      MEMORY_PURPOSE_IDS.retrieve,
    ],
    accessBoundAt: migratedAt,
  });

  await ensureDatabaseSchema();
  return runWithDatabaseSystemScope(
    "Enroll an actor-confirmed legacy durable-memory cohort into its immutable private owner scope.",
    () => getSql().transaction(async (sql: MemorySqlClient) => {
      await sql`
        SELECT set_config(
          'omni.memory_owner_enrollment_v1',
          'true',
          true
        )
      `;
      const rows = await selectLegacyDurableRowsForUpdate(sql, input.tenantId);
      const preview = ownershipPreview(input.tenantId, rows);
      if (preview.manifestSha256 !== input.expectedManifestSha256) {
        throw new LegacyMemoryOwnershipConflictError();
      }
      if (!rows.length) {
        return Object.freeze({
          preview,
          migratedCount: 0,
          reviewCount: 0,
          traceCount: 0,
          removedGraphNodeCount: 0,
          removedGraphEdgeCount: 0,
          recordIds: Object.freeze([]),
        });
      }

      const recordIds = rows.map((row) => row.id);
      await assertNoUnsupportedOwnerDependencies(sql, input.tenantId, recordIds);

      const migratedRows = await sql`
        UPDATE omni_memories
        SET scope = 'user',
            access_contract_version = ${memoryBinding.version},
            access_state = ${memoryBinding.state},
            owner_actor_id = ${memoryBinding.ownerActorId},
            owner_agent_id = NULL,
            workspace_id = NULL,
            project_id = NULL,
            mission_id = NULL,
            visibility = ${memoryBinding.visibility},
            sensitivity = ${memoryBinding.sensitivity},
            origin_purpose = ${memoryBinding.originPurpose},
            allowed_purpose_ids = ${memoryBinding.allowedPurposeIds},
            access_scope_sha256 = ${memoryBinding.accessScopeSha256},
            access_bound_at = ${memoryBinding.accessBoundAt}
        WHERE tenant_id = ${input.tenantId}
          AND access_contract_version = 0
          AND id = ANY(${recordIds}::text[])
        RETURNING id
      `;
      if (migratedRows.length !== recordIds.length) {
        throw new LegacyMemoryOwnershipConflictError();
      }

      const reviewRows = await sql`
        UPDATE omni_memory_reconciliation_reviews
        SET owner_actor_id = ${input.ownerActorId}
        WHERE tenant_id = ${input.tenantId}
          AND owner_actor_id IS NULL
          AND candidate_memory_id = ANY(${recordIds}::text[])
          AND (
            existing_memory_id IS NULL
            OR existing_memory_id = ANY(${recordIds}::text[])
          )
        RETURNING id
      `;
      const traceRows = await sql`
        UPDATE omni_retrieval_traces
        SET access_contract_version = ${traceBinding.version},
            access_state = ${traceBinding.state},
            owner_actor_id = ${traceBinding.ownerActorId},
            owner_agent_id = NULL,
            workspace_id = NULL,
            project_id = NULL,
            mission_id = NULL,
            visibility = ${traceBinding.visibility},
            sensitivity = ${traceBinding.sensitivity},
            origin_purpose = ${traceBinding.originPurpose},
            allowed_purpose_ids = ${traceBinding.allowedPurposeIds},
            access_scope_sha256 = ${traceBinding.accessScopeSha256},
            access_bound_at = ${traceBinding.accessBoundAt}
        WHERE tenant_id = ${input.tenantId}
          AND access_contract_version = 0
          AND memory_ids && ${recordIds}::text[]
        RETURNING id
      `;

      const graphNodeRows = await sql`
        SELECT id
        FROM omni_memory_graph_nodes
        WHERE tenant_id = ${input.tenantId}
          AND access_contract_version = 0
          AND memory_ids && ${recordIds}::text[]
        FOR UPDATE
      `;
      const graphNodeIds = graphNodeRows.map((row) => String(row.id));
      const graphEdgeRows = await sql`
        DELETE FROM omni_memory_graph_edges
        WHERE tenant_id = ${input.tenantId}
          AND access_contract_version = 0
          AND (
            memory_ids && ${recordIds}::text[]
            OR source_node_id = ANY(${graphNodeIds}::text[])
            OR target_node_id = ANY(${graphNodeIds}::text[])
          )
        RETURNING id
      `;
      const removedNodeRows = graphNodeIds.length
        ? await sql`
            DELETE FROM omni_memory_graph_nodes
            WHERE tenant_id = ${input.tenantId}
              AND access_contract_version = 0
              AND id = ANY(${graphNodeIds}::text[])
            RETURNING id
          `
        : [];

      await sql`
        INSERT INTO omni_memory_graph_rebuild_queue AS rebuild (
          tenant_id, requested_at, attempts, last_error, updated_at, generation
        ) VALUES (${input.tenantId}, NOW(), 0, NULL, NOW(), 1)
        ON CONFLICT (tenant_id) DO UPDATE SET
          requested_at = NOW(), attempts = 0, last_error = NULL,
          updated_at = NOW(), generation = rebuild.generation + 1,
          lease_owner = NULL, lease_expires_at = NULL
      `;

      const result = Object.freeze({
        preview,
        migratedCount: migratedRows.length,
        reviewCount: reviewRows.length,
        traceCount: traceRows.length,
        removedGraphNodeCount: removedNodeRows.length,
        removedGraphEdgeCount: graphEdgeRows.length,
        recordIds: Object.freeze([...recordIds]),
      });
      await appendScopedDomainEvent({
        id: `memory_owner_enrollment_${sourceContractSha256({
          ownerActorId: input.ownerActorId,
          manifestSha256: preview.manifestSha256,
          migratedAt,
        })}`,
        streamId: `memory-ownership:${input.ownerActorId}`,
        type: "memory.legacy_owner_enrollment.completed",
        executionScope: scope,
        payload: {
          schemaVersion: 1,
          manifestSha256: preview.manifestSha256,
          migratedCount: result.migratedCount,
          activeCount: preview.activeCount,
          historicalCount: preview.historicalCount,
          reviewCount: result.reviewCount,
          traceCount: result.traceCount,
          removedGraphNodeCount: result.removedGraphNodeCount,
          removedGraphEdgeCount: result.removedGraphEdgeCount,
          migratedAt,
        },
      }, { sql });
      return result;
    }) as Promise<LegacyMemoryOwnershipMigration>,
  );
}

export class LegacyMemoryOwnershipConflictError extends Error {
  constructor() {
    super("Legacy memory ownership changed after preview. Refresh and review it again.");
    this.name = "LegacyMemoryOwnershipConflictError";
  }
}

async function selectLegacyDurableRows(
  sql: MemorySqlClient,
  tenantId: string,
): Promise<LegacyMemoryRow[]> {
  const rows = await sql`
    SELECT id, claim_status, updated_at
    FROM omni_memories memory
    WHERE tenant_id = ${tenantId}
      AND access_contract_version = 0
      AND claim_status <> 'forgotten'
      AND (
        type <> 'knowledge'
        OR tier = 'summary'
        OR COALESCE(formation_reason, 'legacy_record') = ANY(
          ${DURABLE_FORMATION_REASONS}::text[]
        )
        OR NOT (
          COALESCE('rag' = ANY(tags), FALSE)
          OR COALESCE(formation_reason, '') = 'canonical_source_observation'
          OR asserted_by = 'import'
        )
      )
    ORDER BY id COLLATE "C"
    LIMIT 10_000
  `;
  return rows.map(legacyMemoryRow);
}

async function selectLegacyDurableRowsForUpdate(
  sql: MemorySqlClient,
  tenantId: string,
): Promise<LegacyMemoryRow[]> {
  const rows = await sql`
    SELECT id, claim_status, updated_at
    FROM omni_memories memory
    WHERE tenant_id = ${tenantId}
      AND access_contract_version = 0
      AND claim_status <> 'forgotten'
      AND (
        type <> 'knowledge'
        OR tier = 'summary'
        OR COALESCE(formation_reason, 'legacy_record') = ANY(
          ${DURABLE_FORMATION_REASONS}::text[]
        )
        OR NOT (
          COALESCE('rag' = ANY(tags), FALSE)
          OR COALESCE(formation_reason, '') = 'canonical_source_observation'
          OR asserted_by = 'import'
        )
      )
    ORDER BY id COLLATE "C"
    LIMIT 10_000
    FOR UPDATE
  `;
  return rows.map(legacyMemoryRow);
}

async function assertNoUnsupportedOwnerDependencies(
  sql: MemorySqlClient,
  tenantId: string,
  recordIds: readonly string[],
) {
  const rows = await sql`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM omni_memory_lifecycle_states lifecycle
        WHERE lifecycle.tenant_id = ${tenantId}
          AND lifecycle.memory_id = ANY(${recordIds}::text[])
      ) AS lifecycle_count,
      (
        SELECT COUNT(*)::int
        FROM omni_memory_promotion_reviews review
        WHERE review.tenant_id = ${tenantId}
          AND (
            review.canonical_memory_id = ANY(${recordIds}::text[])
            OR review.source_memory_ids && ${recordIds}::text[]
            OR review.promoted_memory_id = ANY(${recordIds}::text[])
          )
      ) AS promotion_count,
      (
        SELECT COUNT(*)::int
        FROM omni_memory_reconciliation_reviews review
        WHERE review.tenant_id = ${tenantId}
          AND review.owner_actor_id IS NULL
          AND (
            review.candidate_memory_id = ANY(${recordIds}::text[])
            OR review.existing_memory_id = ANY(${recordIds}::text[])
          )
          AND NOT (
            review.candidate_memory_id = ANY(${recordIds}::text[])
            AND (
              review.existing_memory_id IS NULL
              OR review.existing_memory_id = ANY(${recordIds}::text[])
            )
          )
      ) AS partial_review_count
  `;
  if (
    Number(rows[0]?.lifecycle_count || 0) > 0 ||
    Number(rows[0]?.promotion_count || 0) > 0 ||
    Number(rows[0]?.partial_review_count || 0) > 0
  ) {
    throw new Error(
      "Legacy memory ownership has mixed lifecycle lineage and requires operator review.",
    );
  }
}

function ownershipPreview(
  tenantId: string,
  rows: readonly LegacyMemoryRow[],
): LegacyMemoryOwnershipPreview {
  const activeCount = rows.filter((row) => row.claimStatus === "active").length;
  return Object.freeze({
    version: 1,
    count: rows.length,
    activeCount,
    historicalCount: rows.length - activeCount,
    manifestSha256: sourceContractSha256({
      version: 1,
      tenantId,
      records: rows.map((row) => ({
        id: row.id,
        claimStatus: row.claimStatus,
        updatedAt: row.updatedAt,
      })),
    }),
  });
}

function legacyMemoryRow(row: Record<string, unknown>): LegacyMemoryRow {
  return Object.freeze({
    id: String(row.id),
    claimStatus: String(row.claim_status),
    updatedAt: new Date(row.updated_at as string | number | Date).toISOString(),
  });
}
