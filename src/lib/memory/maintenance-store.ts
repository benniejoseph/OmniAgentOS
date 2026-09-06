import { createHash } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import {
  parseDatabaseMemoryAccessScope,
  setTransactionLocalDatabaseMemoryAccessScope,
  type DatabaseMemoryAccessScope,
} from "@/lib/db/memory-access-scope";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  MEMORY_LIFECYCLE_POLICY_VERSION,
  memoryArchiveReasonSchema,
  memoryLifecycleActionSchema,
  memoryPromotionDecisionSchema,
  planMemoryMaintenance,
  type MemoryLifecycleAction,
  type MemoryMaintenanceReport,
  type MemoryPromotionDecision,
  type MemoryPromotionReview,
} from "@/lib/memory/lifecycle";
import { listMemories } from "@/lib/memory/store";
import type { MemoryRecord } from "@/lib/memory/types";
import {
  assertExecutionScopeTenant,
  createExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";

type MemorySqlClient = ReturnType<typeof getSql>;

type MaintenanceOptions = {
  tenantId: string;
  accessScope?: DatabaseMemoryAccessScope;
  executionScope: ExecutionScope;
};

type LifecycleLedger = {
  reviews: MemoryPromotionReview[];
};

export class MemoryLifecycleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryLifecycleConflictError";
  }
}

export async function runActorMemoryMaintenance(
  records: readonly MemoryRecord[],
  options: MaintenanceOptions,
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const executionScope = requireExecutionScope(options.executionScope, tenantId);
  assertMaintenanceRecords(records, tenantId, options.accessScope);
  const plan = planMemoryMaintenance(records);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: MemorySqlClient) => {
      await enterMaintenanceScope(sql, options.accessScope, tenantId);
      const archived = await persistPlannedArchives(sql, records, plan.archives);
      const reviews = await persistPlannedPromotionReviews(
        sql,
        records,
        plan.promotionReviews,
      );
      const report = actualMaintenanceReport(plan.report, archived, reviews);
      await appendMaintenanceEvent(sql, executionScope, report);
      return { report, reviews };
    }) as Promise<{
      report: MemoryMaintenanceReport;
      reviews: MemoryPromotionReview[];
    }>;
  }

  const archiveById = new Map(plan.archives.map((item) => [item.memoryId, item]));
  const now = new Date().toISOString();
  await updateJsonFile<MemoryRecord[]>(getDataPath("memory.json"), [], (current) =>
    current.map((memory) => {
      const archive = archiveById.get(memory.id);
      return archive && normalizeTenantId(memory.tenantId) === tenantId
        ? {
            ...memory,
            archivedAt: now,
            archiveReason: archive.reason,
            duplicateOfMemoryId: archive.duplicateOfMemoryId,
          }
        : memory;
    })
  );
  const ledger = await updateJsonFile<LifecycleLedger>(
    getLifecycleFile(),
    { reviews: [] },
    (current) => {
      const byId = new Map(current.reviews.map((review) => [review.id, review]));
      for (const planned of plan.promotionReviews) {
        if (byId.has(planned.id)) continue;
        byId.set(planned.id, {
          ...planned,
          tenantId,
          policyVersion: MEMORY_LIFECYCLE_POLICY_VERSION,
          status: "pending",
          targetTier: "procedural",
          createdAt: now,
          updatedAt: now,
        });
      }
      return { reviews: [...byId.values()] };
    },
  );
  const reviews = ledger.reviews.filter((review) =>
    plan.promotionReviews.some((planned) => planned.id === review.id)
  );
  await appendMaintenanceEvent(undefined, executionScope, plan.report);
  return { report: plan.report, reviews };
}

export async function runTenantMemoryMaintenance(input: {
  tenantId: string;
  executingPrincipalId: string;
  correlationId: string;
  limit?: number;
}) {
  const tenantId = normalizeTenantId(input.tenantId);
  if (!hasDatabaseUrl()) {
    const records = await listMemories({
      tenantId,
      includeInactive: true,
      limit: input.limit || 2_000,
    });
    return runActorMemoryMaintenance(records, {
      tenantId,
      executionScope: maintenanceExecutionScope(input, undefined),
    });
  }

  return runWithDatabaseSystemScope(
    `Apply deterministic memory lifecycle policy for tenant ${tenantId}.`,
    async () => {
      const records = await listMemories({
        tenantId,
        includeInactive: true,
        limit: Math.min(Math.max(input.limit || 5_000, 1), 10_000),
      });
      const groups = new Map<string, MemoryRecord[]>();
      for (const record of records) {
        const ownerActorId = record.accessBinding?.ownerActorId || "";
        const group = groups.get(ownerActorId) || [];
        group.push(record);
        groups.set(ownerActorId, group);
      }
      const results: Array<Awaited<ReturnType<typeof runActorMemoryMaintenance>>> = [];
      for (const [ownerActorId, actorRecords] of groups) {
        results.push(await runActorMemoryMaintenance(actorRecords, {
          tenantId,
          executionScope: maintenanceExecutionScope(
            input,
            ownerActorId || undefined,
          ),
        }));
      }
      return combineMaintenanceResults(results);
    },
  );
}

export async function setMemoryLifecycle(
  memory: MemoryRecord,
  action: MemoryLifecycleAction,
  options: MaintenanceOptions,
) {
  const parsedAction = memoryLifecycleActionSchema.parse(action);
  const tenantId = normalizeTenantId(options.tenantId);
  const executionScope = requireExecutionScope(options.executionScope, tenantId);
  assertMaintenanceRecords([memory], tenantId, options.accessScope);
  if (memory.claimStatus === "forgotten") return null;
  const now = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const lifecycle = await getSql().transaction(async (sql: MemorySqlClient) => {
      await enterMaintenanceScope(sql, options.accessScope, tenantId);
      const rows = await sql`
        INSERT INTO omni_memory_lifecycle_states (
          memory_id, tenant_id, access_contract_version, owner_actor_id,
          policy_version, pinned_at, archived_at, archive_reason,
          duplicate_of_memory_id, created_at, updated_at
        ) VALUES (
          ${memory.id}, ${tenantId}, ${memory.accessBinding?.version || 0},
          ${memory.accessBinding?.ownerActorId || null},
          ${MEMORY_LIFECYCLE_POLICY_VERSION},
          ${parsedAction === "pin" ? now : null},
          ${parsedAction === "archive" ? now : null},
          ${parsedAction === "archive" ? "manual" : null},
          ${null}, ${now}, ${now}
        )
        ON CONFLICT (memory_id) DO UPDATE SET
          pinned_at = CASE
            WHEN ${parsedAction} = 'pin' THEN ${now}::timestamptz
            WHEN ${parsedAction} = 'unpin' THEN NULL
            ELSE omni_memory_lifecycle_states.pinned_at
          END,
          archived_at = CASE
            WHEN ${parsedAction} = 'archive' THEN ${now}::timestamptz
            WHEN ${parsedAction} = 'restore' THEN NULL
            ELSE omni_memory_lifecycle_states.archived_at
          END,
          archive_reason = CASE
            WHEN ${parsedAction} = 'archive' THEN 'manual'
            WHEN ${parsedAction} = 'restore' THEN NULL
            ELSE omni_memory_lifecycle_states.archive_reason
          END,
          duplicate_of_memory_id = CASE
            WHEN ${parsedAction} = 'restore' THEN NULL
            ELSE omni_memory_lifecycle_states.duplicate_of_memory_id
          END,
          updated_at = ${now}
        WHERE (${parsedAction} NOT IN ('pin', 'unpin') OR
                 omni_memory_lifecycle_states.archived_at IS NULL)
          AND (${parsedAction} NOT IN ('archive', 'restore') OR
                 omni_memory_lifecycle_states.pinned_at IS NULL)
        RETURNING *
      `;
      if (!rows[0]) {
        throw new MemoryLifecycleConflictError(
          parsedAction === "pin" || parsedAction === "unpin"
            ? "Restore this memory before changing its pin."
            : "Unpin this memory before changing its archive state.",
        );
      }
      await appendLifecycleEvent(sql, executionScope, memory.id, parsedAction);
      return lifecycleFromRow(rows[0]);
    }) as ReturnType<typeof lifecycleFromRow>;
    return lifecycle;
  }

  let lifecycle: MemoryRecord | undefined;
  await updateJsonFile<MemoryRecord[]>(getDataPath("memory.json"), [], (current) =>
    current.map((record) => {
      if (record.id !== memory.id || normalizeTenantId(record.tenantId) !== tenantId) {
        return record;
      }
      if (
        (parsedAction === "pin" || parsedAction === "unpin") && record.archivedAt
      ) {
        throw new MemoryLifecycleConflictError(
          "Restore this memory before changing its pin.",
        );
      }
      if (
        (parsedAction === "archive" || parsedAction === "restore") && record.pinnedAt
      ) {
        throw new MemoryLifecycleConflictError(
          "Unpin this memory before changing its archive state.",
        );
      }
      lifecycle = {
        ...record,
        pinnedAt: parsedAction === "pin"
          ? now
          : parsedAction === "unpin"
            ? undefined
            : record.pinnedAt,
        archivedAt: parsedAction === "archive"
          ? now
          : parsedAction === "restore"
            ? undefined
            : record.archivedAt,
        archiveReason: parsedAction === "archive"
          ? "manual"
          : parsedAction === "restore"
            ? undefined
            : record.archiveReason,
        duplicateOfMemoryId: parsedAction === "restore"
          ? undefined
          : record.duplicateOfMemoryId,
      };
      return lifecycle;
    })
  );
  if (!lifecycle) return null;
  await appendLifecycleEvent(undefined, executionScope, memory.id, parsedAction);
  return lifecycle;
}

export async function listMemoryPromotionReviews(options: {
  tenantId: string;
  status?: "pending" | "resolved" | "all";
  limit?: number;
  accessScope?: DatabaseMemoryAccessScope;
}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const status = options.status || "pending";
  const limit = Math.min(Math.max(options.limit || 100, 1), 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const read = (sql: MemorySqlClient) => status === "all"
      ? sql`SELECT * FROM omni_memory_promotion_reviews WHERE tenant_id = ${tenantId} ORDER BY (status = 'pending') DESC, updated_at DESC LIMIT ${limit}`
      : sql`SELECT * FROM omni_memory_promotion_reviews WHERE tenant_id = ${tenantId} AND status = ${status} ORDER BY updated_at DESC LIMIT ${limit}`;
    const rows = options.accessScope
      ? await withMemoryScope(options.accessScope, tenantId, read, [
          MEMORY_PURPOSE_IDS.read,
          MEMORY_PURPOSE_IDS.maintenance,
        ])
      : await read(getSql());
    return rows.map(promotionReviewFromRow);
  }
  const ledger = await readJsonFile<LifecycleLedger>(
    getLifecycleFile(),
    { reviews: [] },
  );
  return ledger.reviews.filter((review) =>
    review.tenantId === tenantId &&
    (status === "all" || review.status === status)
  ).slice(0, limit);
}

export async function resolveMemoryPromotionReview(
  reviewId: string,
  decision: MemoryPromotionDecision,
  promotedMemoryId: string | undefined,
  options: MaintenanceOptions,
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const parsedDecision = memoryPromotionDecisionSchema.parse(decision);
  const executionScope = requireExecutionScope(options.executionScope, tenantId);
  if ((parsedDecision === "promote") !== Boolean(promotedMemoryId)) {
    throw new Error("A promoted memory id is required only for promotion.");
  }
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: MemorySqlClient) => {
      await enterMaintenanceScope(sql, options.accessScope, tenantId);
      const currentRows = await sql`
        SELECT * FROM omni_memory_promotion_reviews
        WHERE tenant_id = ${tenantId} AND id = ${reviewId}
        LIMIT 1 FOR UPDATE
      `;
      if (!currentRows[0]) return null;
      const current = promotionReviewFromRow(currentRows[0]);
      if (current.status === "resolved") {
        if (
          current.decision !== parsedDecision ||
          current.promotedMemoryId !== promotedMemoryId
        ) {
          throw new MemoryLifecycleConflictError(
            "This promotion review already has a different decision.",
          );
        }
        return current;
      }
      const rows = await sql`
        UPDATE omni_memory_promotion_reviews
        SET status = 'resolved', decision = ${parsedDecision},
            promoted_memory_id = ${promotedMemoryId || null},
            resolved_at = NOW(), updated_at = NOW()
        WHERE tenant_id = ${tenantId} AND id = ${reviewId}
        RETURNING *
      `;
      await appendScopedDomainEvent({
        id: `memory_promotion_decision_${sha256(`${reviewId}:${parsedDecision}:${promotedMemoryId || "none"}`)}`,
        streamId: `memory-promotion:${reviewId}`,
        type: "memory.promotion.reviewed",
        executionScope,
        payload: {
          schemaVersion: 1,
          reviewId,
          decision: parsedDecision,
          sourceMemoryCount: current.sourceMemoryIds.length,
          sourceClaimSha256: current.sourceClaimSha256,
          promotedMemoryId: promotedMemoryId || null,
        },
      }, { sql });
      return rows[0] ? promotionReviewFromRow(rows[0]) : null;
    }) as Promise<MemoryPromotionReview | null>;
  }

  let resolved: MemoryPromotionReview | null = null;
  await updateJsonFile<LifecycleLedger>(getLifecycleFile(), { reviews: [] }, (ledger) => ({
    reviews: ledger.reviews.map((review) => {
      if (review.id !== reviewId || review.tenantId !== tenantId) return review;
      if (review.status === "resolved") {
        if (
          review.decision !== parsedDecision ||
          review.promotedMemoryId !== promotedMemoryId
        ) {
          throw new MemoryLifecycleConflictError(
            "This promotion review already has a different decision.",
          );
        }
        resolved = review;
        return review;
      }
      const now = new Date().toISOString();
      resolved = {
        ...review,
        status: "resolved",
        decision: parsedDecision,
        ...(promotedMemoryId ? { promotedMemoryId } : {}),
        resolvedAt: now,
        updatedAt: now,
      };
      return resolved;
    }),
  }));
  return resolved;
}

function assertMaintenanceRecords(
  records: readonly MemoryRecord[],
  tenantId: string,
  accessScope?: DatabaseMemoryAccessScope,
) {
  const scope = accessScope
    ? parseDatabaseMemoryAccessScope(accessScope)
    : undefined;
  if (scope && (
    scope.tenantId !== tenantId || scope.purposeId !== MEMORY_PURPOSE_IDS.maintenance
  )) {
    throw new Error("Memory access scope does not match maintenance.");
  }
  for (const record of records) {
    if (normalizeTenantId(record.tenantId) !== tenantId) {
      throw new Error("Memory maintenance cannot mix tenants.");
    }
    if (record.accessBinding) {
      if (!scope || record.accessBinding.ownerActorId !== scope.initiatingActorId) {
        throw new Error("Scoped memory maintenance requires its exact owner.");
      }
    } else if (scope) {
      throw new Error("Legacy memory maintenance cannot inherit a private scope.");
    }
  }
}

async function enterMaintenanceScope(
  sql: MemorySqlClient,
  accessScope: DatabaseMemoryAccessScope | undefined,
  tenantId: string,
) {
  if (!accessScope) return;
  const scope = parseDatabaseMemoryAccessScope(accessScope);
  if (
    scope.tenantId !== tenantId ||
    scope.purposeId !== MEMORY_PURPOSE_IDS.maintenance
  ) {
    throw new Error("Memory access scope does not match maintenance.");
  }
  await setTransactionLocalDatabaseMemoryAccessScope(sql, scope);
}

async function withMemoryScope<T>(
  accessScope: DatabaseMemoryAccessScope,
  tenantId: string,
  operation: (sql: MemorySqlClient) => Promise<T>,
  allowedPurposes: readonly string[],
) {
  const scope = parseDatabaseMemoryAccessScope(accessScope);
  if (scope.tenantId !== tenantId || !allowedPurposes.includes(scope.purposeId)) {
    throw new Error("Memory access scope does not match this operation.");
  }
  return getSql().transaction(async (sql: MemorySqlClient) => {
    await setTransactionLocalDatabaseMemoryAccessScope(sql, scope);
    return operation(sql);
  }) as Promise<T>;
}

async function persistPlannedArchives(
  sql: MemorySqlClient,
  records: readonly MemoryRecord[],
  archives: ReturnType<typeof planMemoryMaintenance>["archives"],
) {
  if (!archives.length) return [];
  const byId = new Map(records.map((record) => [record.id, record]));
  const payload = archives.map((archive) => {
    const memory = byId.get(archive.memoryId);
    if (!memory) throw new Error("Memory maintenance archive lost its source.");
    return {
      memory_id: memory.id,
      tenant_id: normalizeTenantId(memory.tenantId),
      access_contract_version: memory.accessBinding?.version || 0,
      owner_actor_id: memory.accessBinding?.ownerActorId || null,
      archive_reason: archive.reason,
      duplicate_of_memory_id: archive.duplicateOfMemoryId || null,
    };
  });
  return sql`
    WITH input_rows AS (
      SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS input(
        memory_id text, tenant_id text, access_contract_version smallint,
        owner_actor_id text, archive_reason text, duplicate_of_memory_id text
      )
    )
    INSERT INTO omni_memory_lifecycle_states (
      memory_id, tenant_id, access_contract_version, owner_actor_id,
      policy_version, archived_at, archive_reason, duplicate_of_memory_id
    )
    SELECT memory_id, tenant_id, access_contract_version, owner_actor_id,
           ${MEMORY_LIFECYCLE_POLICY_VERSION}, NOW(), archive_reason,
           duplicate_of_memory_id
    FROM input_rows
    ON CONFLICT (memory_id) DO UPDATE SET
      archived_at = COALESCE(omni_memory_lifecycle_states.archived_at, NOW()),
      archive_reason = COALESCE(
        omni_memory_lifecycle_states.archive_reason,
        EXCLUDED.archive_reason
      ),
      duplicate_of_memory_id = COALESCE(
        omni_memory_lifecycle_states.duplicate_of_memory_id,
        EXCLUDED.duplicate_of_memory_id
      ),
      updated_at = NOW()
    WHERE omni_memory_lifecycle_states.pinned_at IS NULL
      AND omni_memory_lifecycle_states.archived_at IS NULL
    RETURNING *
  `;
}

async function persistPlannedPromotionReviews(
  sql: MemorySqlClient,
  records: readonly MemoryRecord[],
  reviews: ReturnType<typeof planMemoryMaintenance>["promotionReviews"],
) {
  if (!reviews.length) return [];
  const byId = new Map(records.map((record) => [record.id, record]));
  const payload = reviews.map((review) => {
    const canonical = byId.get(review.canonicalMemoryId);
    if (!canonical) throw new Error("Promotion review lost its canonical source.");
    return {
      id: review.id,
      tenant_id: normalizeTenantId(canonical.tenantId),
      access_contract_version: canonical.accessBinding?.version || 0,
      owner_actor_id: canonical.accessBinding?.ownerActorId || null,
      source_memory_ids: review.sourceMemoryIds,
      canonical_memory_id: review.canonicalMemoryId,
      source_claim_sha256: review.sourceClaimSha256,
    };
  });
  const rows = await sql`
    WITH input_rows AS (
      SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS input(
        id text, tenant_id text, access_contract_version smallint,
        owner_actor_id text, source_memory_ids text[], canonical_memory_id text,
        source_claim_sha256 text
      )
    )
    INSERT INTO omni_memory_promotion_reviews (
      id, tenant_id, access_contract_version, owner_actor_id, policy_version,
      status, source_memory_ids, canonical_memory_id, source_claim_sha256,
      target_tier
    )
    SELECT id, tenant_id, access_contract_version, owner_actor_id,
           ${MEMORY_LIFECYCLE_POLICY_VERSION}, 'pending', source_memory_ids,
           canonical_memory_id, source_claim_sha256, 'procedural'
    FROM input_rows
    ON CONFLICT (id) DO NOTHING
    RETURNING *
  `;
  return rows.map(promotionReviewFromRow);
}

function actualMaintenanceReport(
  report: MemoryMaintenanceReport,
  archivedRows: Array<Record<string, unknown>>,
  insertedReviews: MemoryPromotionReview[],
): MemoryMaintenanceReport {
  const archivedReasons = archivedRows.map((row) =>
    memoryArchiveReasonSchema.parse(row.archive_reason)
  );
  return {
    ...report,
    autoArchivedDuplicates: archivedReasons.filter(
      (reason) => reason === "exact_duplicate",
    ).length,
    expiredArchived: archivedReasons.filter(
      (reason) => reason === "retention_expired",
    ).length,
    promotionReviewsCreated: insertedReviews.length,
  };
}

function combineMaintenanceResults(
  results: readonly Awaited<ReturnType<typeof runActorMemoryMaintenance>>[],
) {
  const total = (field: keyof MemoryMaintenanceReport) => results.reduce(
    (sum, result) => sum + Number(result.report[field]),
    0,
  );
  const eligible = total("eligible");
  const beforeDuplicates = results.reduce(
    (sum, result) => sum +
      Math.round(result.report.duplicateRateBefore * result.report.eligible),
    0,
  );
  const afterPopulation = results.reduce(
    (sum, result) => sum + result.report.eligible -
      result.report.autoArchivedDuplicates,
    0,
  );
  const afterDuplicates = results.reduce(
    (sum, result) => sum +
      Math.round(
        result.report.duplicateRateAfter *
          Math.max(0, result.report.eligible - result.report.autoArchivedDuplicates),
      ),
    0,
  );
  const report: MemoryMaintenanceReport = {
    policyVersion: MEMORY_LIFECYCLE_POLICY_VERSION,
    scanned: total("scanned"),
    eligible,
    exactDuplicateGroups: total("exactDuplicateGroups"),
    autoArchivedDuplicates: total("autoArchivedDuplicates"),
    pinnedDuplicateConflicts: total("pinnedDuplicateConflicts"),
    promotionReviewsCreated: total("promotionReviewsCreated"),
    expiredArchived: total("expiredArchived"),
    duplicateRateBefore: eligible
      ? Number((beforeDuplicates / eligible).toFixed(6))
      : 0,
    duplicateRateAfter: afterPopulation
      ? Number((afterDuplicates / afterPopulation).toFixed(6))
      : 0,
    duplicateRateTarget: 0.01,
  };
  return {
    report,
    reviews: results.flatMap((result) => result.reviews),
  };
}

function maintenanceExecutionScope(
  input: {
    tenantId: string;
    executingPrincipalId: string;
    correlationId: string;
  },
  ownerActorId?: string,
) {
  return createExecutionScope({
    tenantId: input.tenantId,
    initiatingActorId: ownerActorId || input.executingPrincipalId,
    executingPrincipalType: "system",
    executingPrincipalId: input.executingPrincipalId,
    workspaceId: null,
    projectId: null,
    missionId: null,
    correlationId: `${input.correlationId}:${sha256(ownerActorId || "legacy").slice(0, 12)}`,
    purpose: "memory.maintenance.worker.v1",
  });
}

function requireExecutionScope(scope: ExecutionScope, tenantId: string) {
  const parsed = parsePersistedExecutionScope(scope);
  if (!parsed) throw new Error("Memory maintenance requires an execution scope.");
  assertExecutionScopeTenant(parsed, tenantId);
  return parsed;
}

async function appendMaintenanceEvent(
  sql: MemorySqlClient | undefined,
  executionScope: ExecutionScope,
  report: MemoryMaintenanceReport,
) {
  await appendScopedDomainEvent({
    id: `memory_maintenance_${sha256(`${executionScope.correlationId}:${JSON.stringify(report)}`)}`,
    streamId: `memory-maintenance:${executionScope.tenantId}`,
    type: "memory.maintenance.completed",
    executionScope,
    payload: report,
  }, sql ? { sql } : undefined);
}

async function appendLifecycleEvent(
  sql: MemorySqlClient | undefined,
  executionScope: ExecutionScope,
  memoryId: string,
  action: MemoryLifecycleAction,
) {
  await appendScopedDomainEvent({
    id: `memory_lifecycle_${sha256(`${executionScope.correlationId}:${memoryId}:${action}`)}`,
    streamId: `memory:${memoryId}`,
    type: `memory.lifecycle.${action}`,
    executionScope,
    payload: {
      schemaVersion: 1,
      policyVersion: MEMORY_LIFECYCLE_POLICY_VERSION,
      memoryId,
      action,
      historicalTruthChanged: false,
    },
  }, sql ? { sql } : undefined);
}

function lifecycleFromRow(row: Record<string, unknown>) {
  return {
    memoryId: String(row.memory_id),
    policyVersion: MEMORY_LIFECYCLE_POLICY_VERSION,
    pinnedAt: row.pinned_at ? timestamp(row.pinned_at) : undefined,
    archivedAt: row.archived_at ? timestamp(row.archived_at) : undefined,
    archiveReason: row.archive_reason
      ? memoryArchiveReasonSchema.parse(row.archive_reason)
      : undefined,
    duplicateOfMemoryId: row.duplicate_of_memory_id
      ? String(row.duplicate_of_memory_id)
      : undefined,
    updatedAt: timestamp(row.updated_at),
  };
}

function promotionReviewFromRow(
  row: Record<string, unknown>,
): MemoryPromotionReview {
  const status = String(row.status);
  if (status !== "pending" && status !== "resolved") {
    throw new Error("Memory promotion review status is invalid.");
  }
  const decision = row.decision
    ? memoryPromotionDecisionSchema.parse(row.decision)
    : undefined;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    ...(row.owner_actor_id ? { ownerActorId: String(row.owner_actor_id) } : {}),
    policyVersion: MEMORY_LIFECYCLE_POLICY_VERSION,
    status,
    ...(decision ? { decision } : {}),
    sourceMemoryIds: Array.isArray(row.source_memory_ids)
      ? row.source_memory_ids.map(String)
      : [],
    canonicalMemoryId: String(row.canonical_memory_id),
    sourceClaimSha256: String(row.source_claim_sha256),
    targetTier: "procedural",
    ...(row.promoted_memory_id
      ? { promotedMemoryId: String(row.promoted_memory_id) }
      : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    ...(row.resolved_at ? { resolvedAt: timestamp(row.resolved_at) } : {}),
  };
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid timestamp.");
  return date.toISOString();
}

function normalizeTenantId(value?: string) {
  return (value || "default").trim().replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}

function getLifecycleFile() {
  return getDataPath("memory-lifecycle.json");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
