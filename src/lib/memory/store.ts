import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  parseDatabaseMemoryAccessScope,
  serializeDatabaseMemoryAccessScope,
  setTransactionLocalDatabaseMemoryAccessScope,
  type DatabaseMemoryAccessScope,
} from "@/lib/db/memory-access-scope";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  buildMemoryDeletionReceiptV1,
  canonicalizeMemoryDeletionIds,
  memoryDeletionContractSha256,
  parseMemoryDeletionReceiptV1,
  type MemoryDeletionReceiptV1,
} from "@/lib/memory/deletion-receipt";
import {
  buildMemoryDeletionPreviewV1,
  type MemoryDeletionPreviewV1,
} from "@/lib/memory/deletion-preview";
import { getDataPath } from "@/lib/storage/paths";
import { redactSensitive } from "@/lib/security/context";
import {
  assertExecutionScopeTenant,
  executionScopesEqual,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import type { MemoryRecord, MemorySearchResult, MemoryType } from "@/lib/memory/types";
import { isTemporalIntervalActive } from "@/lib/memory/temporal";
import {
  MEMORY_PURPOSE_IDS,
  memoryAccessBindingAllows,
  memoryAccessBindingV1Schema,
  type MemoryAccessBindingV1,
} from "@/lib/memory/access-binding";
import { cosineSimilarity, parseEmbedding, toVectorLiteral } from "@/lib/rag/vector";
import {
  assertCaptureIngestSource,
  lockActiveCaptureIngest,
  type CaptureIngestGuard,
} from "@/lib/capture/ingest-guard";
import { invalidateRunsForDeletedContext } from "@/lib/runs/context-invalidation";

export type CreateMemoryInput = {
  id?: string;
  tenantId?: string;
  type?: MemoryType;
  title: string;
  content: string;
  tags?: string[];
  scope?: MemoryRecord["scope"];
  source?: string;
  importance?: number;
  confidence?: number;
  claimStatus?: MemoryRecord["claimStatus"];
  assertedBy?: MemoryRecord["assertedBy"];
  evidenceRefs?: string[];
  validFrom?: string;
  validTo?: string;
  supersedesId?: string;
  contradictionOfId?: string;
  embedding?: number[];
  accessBinding?: MemoryAccessBindingV1;
  databaseAccessScope?: DatabaseMemoryAccessScope;
};

type TenantScopedOptions = {
  tenantId?: string;
  limit?: number;
  includeInactive?: boolean;
  type?: MemoryType;
  sql?: MemorySqlClient;
  accessScope?: DatabaseMemoryAccessScope;
};

type MemorySqlClient = ReturnType<typeof getSql>;

export async function listMemories(options: TenantScopedOptions = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const limit = options.limit || 500;

  if (hasDatabaseUrl()) {
    if (!options.sql) {
      await ensureDatabaseSchema();
    }
    if (options.sql && options.accessScope) {
      throw new Error(
        "Scoped memory reads must own their database transaction.",
      );
    }
    const readRows = async (sql: MemorySqlClient) => options.includeInactive
      ? options.type
        ? sql`SELECT * FROM omni_memories WHERE tenant_id = ${tenantId} AND type = ${options.type} AND claim_status <> 'forgotten' ORDER BY updated_at DESC LIMIT ${limit}`
        : sql`SELECT * FROM omni_memories WHERE tenant_id = ${tenantId} AND claim_status <> 'forgotten' ORDER BY updated_at DESC LIMIT ${limit}`
      : options.type
        ? sql`SELECT * FROM omni_memories WHERE tenant_id = ${tenantId} AND type = ${options.type} AND claim_status = 'active' AND (valid_from IS NULL OR valid_from <= NOW()) AND (valid_to IS NULL OR valid_to > NOW()) ORDER BY updated_at DESC LIMIT ${limit}`
        : sql`SELECT * FROM omni_memories WHERE tenant_id = ${tenantId} AND claim_status = 'active' AND (valid_from IS NULL OR valid_from <= NOW()) AND (valid_to IS NULL OR valid_to > NOW()) ORDER BY updated_at DESC LIMIT ${limit}`;
    const rows = options.accessScope
      ? await runWithDatabaseMemoryAccessScope(
          options.accessScope,
          tenantId,
          readRows,
          [
            MEMORY_PURPOSE_IDS.read,
            MEMORY_PURPOSE_IDS.retrieve,
            MEMORY_PURPOSE_IDS.export,
          ],
        )
      : await readRows(options.sql || getSql());
    return rows.map(memoryFromRow);
  }

  const memories = await readJsonFile<MemoryRecord[]>(getMemoryFile(), []);
  return memories
    .filter((memory) => normalizeTenantId(memory.tenantId) === tenantId)
    .filter((memory) => memoryVisibleForScope(memory, options.accessScope))
    .filter((memory) => !options.type || memory.type === options.type)
    .filter((memory) => sanitizeMemoryRecord(memory).claimStatus !== "forgotten")
    .filter((memory) => options.includeInactive || isActiveMemory(sanitizeMemoryRecord(memory)))
    .slice(0, limit)
    .map(sanitizeMemoryRecord);
}

export async function listThreadMemories(
  threadId: string,
  options: Pick<
    TenantScopedOptions,
    "tenantId" | "limit" | "sql" | "accessScope"
  > = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const limit = Math.min(Math.max(options.limit || 100, 1), 100);
  const evidenceRef = `thread:${threadId.trim().slice(0, 200)}`;

  if (hasDatabaseUrl()) {
    if (!options.sql) {
      await ensureDatabaseSchema();
    }
    if (options.sql && options.accessScope) {
      throw new Error(
        "Scoped memory reads must own their database transaction.",
      );
    }
    const readRows = (sql: MemorySqlClient) => sql`
        SELECT *
        FROM omni_memories
        WHERE tenant_id = ${tenantId}
          AND claim_status <> 'forgotten'
          AND ${evidenceRef} = ANY(evidence_refs)
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
    const rows = options.accessScope
      ? await runWithDatabaseMemoryAccessScope(
          options.accessScope,
          tenantId,
          readRows,
          [MEMORY_PURPOSE_IDS.read, MEMORY_PURPOSE_IDS.retrieve],
        )
      : await readRows(options.sql || getSql());
    return rows.map(memoryFromRow);
  }

  const memories = await readJsonFile<MemoryRecord[]>(getMemoryFile(), []);
  return memories
    .map(sanitizeMemoryRecord)
    .filter((memory) => normalizeTenantId(memory.tenantId) === tenantId)
    .filter((memory) => memoryVisibleForScope(memory, options.accessScope))
    .filter((memory) => memory.claimStatus !== "forgotten")
    .filter((memory) => memory.evidenceRefs?.includes(evidenceRef))
    .slice(0, limit);
}

function memoryRecordFromInput(
  input: CreateMemoryInput,
  now: string,
): MemoryRecord {
  const tenantId = normalizeTenantId(input.tenantId);
  const accessBinding = input.accessBinding
    ? memoryAccessBindingV1Schema.parse(input.accessBinding)
    : undefined;
  if (accessBinding && accessBinding.tenantId !== tenantId) {
    throw new Error("Memory access binding tenant does not match the record.");
  }
  const title = String(redactSensitive(input.title)).slice(0, 240);
  const content = String(redactSensitive(input.content)).slice(0, 200_000);
  const tags = normalizeTags(
    (input.tags || []).map((tag) => String(redactSensitive(tag))),
  );
  const source = String(
    redactSensitive(input.source || "manual"),
  ).slice(0, 2_000);
  const textWasRedacted =
    title !== input.title || content !== input.content;
  return {
    id: input.id?.trim().slice(0, 200) || randomUUID(),
    tenantId,
    type: input.type || "fact",
    title,
    content,
    tags,
    scope: input.scope || "workspace",
    source,
    importance: input.importance ?? 0.5,
    confidence: clamp01(input.confidence ?? (source === "manual" ? 0.95 : 0.7)),
    claimStatus: normalizeClaimStatus(input.claimStatus),
    assertedBy: input.assertedBy || (source === "manual" ? "user" : source === "agent" || source === "consolidator" ? "agent" : "system"),
    evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs || []),
    validFrom: normalizeOptionalDate(input.validFrom),
    validTo: normalizeOptionalDate(input.validTo),
    supersedesId: normalizeOptionalId(input.supersedesId),
    contradictionOfId: normalizeOptionalId(input.contradictionOfId),
    createdAt: now,
    updatedAt: now,
    embedding: textWasRedacted ? undefined : input.embedding,
    ...(accessBinding ? { accessBinding } : {}),
  };
}

export async function saveMemory(input: CreateMemoryInput) {
  return (await saveMemoryWithCommitStatus(input)).record;
}

export async function saveMemories(
  inputs: CreateMemoryInput[],
  options: { captureIngestGuard?: CaptureIngestGuard } = {},
) {
  return (await saveMemoriesWithCommitStatus(inputs, options)).map(
    (result) => result.record,
  );
}

/**
 * Narrow first-party acknowledgement used by governed effect receipts. The
 * existing saveMemory API intentionally keeps its historical return shape.
 */
export async function saveMemoryWithCommitStatus(input: CreateMemoryInput) {
  const result = (await saveMemoriesWithCommitStatus([input]))[0];
  if (!result) {
    throw new Error("Memory persistence did not return a result.");
  }
  return result;
}

async function saveMemoriesWithCommitStatus(
  inputs: CreateMemoryInput[],
  options: { captureIngestGuard?: CaptureIngestGuard } = {},
) {
  if (!inputs.length) {
    return [];
  }
  const now = new Date().toISOString();
  const records = inputs.map((input) => memoryRecordFromInput(input, now));
  const tenantId = normalizeTenantId(records[0].tenantId);
  if (
    records.some(
      (record) => normalizeTenantId(record.tenantId) !== tenantId,
    )
  ) {
    throw new Error("Bulk memory persistence cannot mix tenants.");
  }
  const databaseAccessScope = resolveDatabaseMemoryWriteScope(
    inputs,
    records,
    tenantId,
  );
  if (options.captureIngestGuard && databaseAccessScope) {
    throw new Error(
      "Capture ingestion cannot enter the user-private memory canary.",
    );
  }
  if (options.captureIngestGuard) {
    for (const record of records) {
      assertCaptureIngestSource(
        options.captureIngestGuard,
        tenantId,
        record.source,
      );
    }
  }

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const payload = records.map((record) => ({
      id: record.id,
      tenant_id: record.tenantId,
      type: record.type,
      title: record.title,
      content: record.content,
      tags: record.tags,
      scope: record.scope,
      source: record.source,
      importance: record.importance,
      confidence: record.confidence,
      claim_status: record.claimStatus,
      asserted_by: record.assertedBy,
      evidence_refs: record.evidenceRefs,
      valid_from: record.validFrom || null,
      valid_to: record.validTo || null,
      supersedes_id: record.supersedesId || null,
      contradiction_of_id: record.contradictionOfId || null,
      embedding: record.embedding || null,
      access_contract_version: record.accessBinding?.version || 0,
      access_state: record.accessBinding?.state || "legacy_unattributed",
      owner_actor_id: record.accessBinding?.ownerActorId || null,
      owner_agent_id: record.accessBinding?.ownerAgentId || null,
      workspace_id: record.accessBinding?.workspaceId || null,
      project_id: record.accessBinding?.projectId || null,
      mission_id: record.accessBinding?.missionId || null,
      visibility: record.accessBinding?.visibility || null,
      sensitivity: record.accessBinding?.sensitivity || null,
      origin_purpose: record.accessBinding?.originPurpose || null,
      allowed_purpose_ids: record.accessBinding?.allowedPurposeIds || null,
      access_scope_sha256: record.accessBinding?.accessScopeSha256 || null,
      access_bound_at: record.accessBinding?.accessBoundAt || null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }));
    const persistRows = (sql: MemorySqlClient) => sql`
      WITH input_rows AS (
        SELECT *
        FROM jsonb_to_recordset(${payload}::jsonb) AS input(
          id text,
          tenant_id text,
          type text,
          title text,
          content text,
          tags text[],
          scope text,
          source text,
          importance double precision,
          confidence double precision,
          claim_status text,
          asserted_by text,
          evidence_refs text[],
          valid_from timestamptz,
          valid_to timestamptz,
          supersedes_id text,
          contradiction_of_id text,
          embedding jsonb,
          access_contract_version smallint,
          access_state text,
          owner_actor_id text,
          owner_agent_id text,
          workspace_id text,
          project_id text,
          mission_id text,
          visibility text,
          sensitivity text,
          origin_purpose text,
          allowed_purpose_ids text[],
          access_scope_sha256 text,
          access_bound_at timestamptz,
          created_at timestamptz,
          updated_at timestamptz
        )
      ),
      inserted AS (
        INSERT INTO omni_memories (
          id, tenant_id, type, title, content, tags, scope, source, importance,
          confidence, claim_status, asserted_by, evidence_refs, valid_from, valid_to,
          supersedes_id, contradiction_of_id, embedding,
          access_contract_version, access_state, owner_actor_id, owner_agent_id,
          workspace_id, project_id, mission_id, visibility, sensitivity,
          origin_purpose, allowed_purpose_ids, access_scope_sha256,
          access_bound_at, created_at, updated_at
        )
        SELECT
          id, tenant_id, type, title, content, tags, scope, source, importance,
          confidence, claim_status, asserted_by, evidence_refs, valid_from, valid_to,
          supersedes_id, contradiction_of_id, embedding,
          access_contract_version, access_state, owner_actor_id, owner_agent_id,
          workspace_id, project_id, mission_id, visibility, sensitivity,
          origin_purpose, allowed_purpose_ids, access_scope_sha256,
          access_bound_at, created_at, updated_at
        FROM input_rows
        ON CONFLICT (id) DO NOTHING
        RETURNING omni_memories.*, TRUE AS _inserted
      )
      SELECT * FROM inserted
      UNION ALL
      SELECT memory.*, FALSE AS _inserted
      FROM input_rows input
      JOIN omni_memories memory
        ON memory.id = input.id
       AND memory.tenant_id = input.tenant_id
    `;
    let rows: Array<Record<string, unknown>>;
    if (options.captureIngestGuard) {
      rows = await getSql().transaction(async (sql: MemorySqlClient) => {
        await lockActiveCaptureIngest(sql, options.captureIngestGuard!);
        return persistRows(sql);
      }) as Array<Record<string, unknown>>;
    } else if (databaseAccessScope) {
      rows = await getSql().transaction(async (sql: MemorySqlClient) => {
        await setTransactionLocalDatabaseMemoryAccessScope(
          sql,
          databaseAccessScope,
        );
        const persistedRows = await persistRows(sql);
        await updateInsertedMemoryVectors(sql, persistedRows, records, tenantId);
        return persistedRows;
      }) as Array<Record<string, unknown>>;
    } else {
      rows = await persistRows(getSql());
    }
    if (rows.length !== records.length) {
      throw new Error("Memory idempotency key collided with another tenant.");
    }
    const byId = new Map(
      rows.map((row) => [
        String(row.id),
        {
          record: memoryFromRow(row),
          inserted: Boolean(row._inserted),
        },
      ] as const),
    );
    if (!databaseAccessScope) {
      await updateInsertedMemoryVectors(getSql(), rows, records, tenantId);
    }
    return records.map((record) => {
      const result = byId.get(record.id);
      if (!result) {
        throw new Error("Bulk memory persistence did not return a saved row.");
      }
      return result;
    });
  }

  const savedById = new Map<
    string,
    { record: MemoryRecord; inserted: boolean }
  >();
  await updateJsonFile<MemoryRecord[]>(getMemoryFile(), [], (memories) => {
    const next = [...memories];
    for (const record of records) {
      const existing = next.find((memory) => memory.id === record.id);
      if (existing) {
        if (normalizeTenantId(existing.tenantId) !== record.tenantId) {
          throw new Error(
            "Memory idempotency key collided with another tenant.",
          );
        }
        savedById.set(record.id, { record: existing, inserted: false });
        continue;
      }
      next.unshift(record);
      savedById.set(record.id, { record, inserted: true });
    }
    return next;
  });
  return records.map((record) => {
    const result = savedById.get(record.id);
    if (!result) {
      throw new Error("Memory persistence did not return a saved row.");
    }
    return result;
  });
}

export async function searchMemories(
  query: string,
  options: {
    limit?: number;
    queryEmbedding?: number[];
    tenantId?: string;
    accessScope?: DatabaseMemoryAccessScope;
  } = {},
): Promise<MemorySearchResult[]> {
  if (hasDatabaseUrl() && !options.accessScope) {
    const results = await searchMemoriesDb(query, options);
    if (results.length) {
      return results;
    }
  }

  const memories = await listMemories({
    tenantId: options.tenantId,
    accessScope: options.accessScope,
  });
  const terms = tokenize(query);
  const limit = options.limit || 8;

  return memories
    .filter((record) => record.claimStatus === "active")
    .map((record) => {
      const text = `${record.title} ${record.content} ${record.tags.join(" ")}`;
      const recordTerms = tokenize(text);
      const overlap = terms.filter((term) => recordTerms.includes(term));
      const lexicalScore = terms.length === 0 ? 0 : overlap.length / terms.length;
      const tagScore = record.tags.filter((tag) => terms.includes(tag)).length * 0.12;
      const importanceScore = record.importance * 0.12;
      const embeddingScore =
        options.queryEmbedding && record.embedding
          ? Math.max(0, cosineSimilarity(options.queryEmbedding, record.embedding))
          : 0;
      const confidence = clamp01(record.confidence ?? 0.7);
      const score = (lexicalScore + tagScore + importanceScore + embeddingScore) * (0.35 + confidence * 0.65);
      const reasons = [
        overlap.length ? `matched ${overlap.slice(0, 5).join(", ")}` : "",
        embeddingScore ? "semantic match" : "",
        record.importance >= 0.8 ? "high importance" : "",
        confidence >= 0.85 ? "high-confidence claim" : confidence < 0.5 ? "low-confidence claim" : "",
      ].filter(Boolean);

      return { record, score, reasons };
    })
    .filter((result) => result.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function getMemory(
  id: string,
  options: {
    tenantId?: string;
    accessScope?: DatabaseMemoryAccessScope;
  } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const readRows = (sql: MemorySqlClient) =>
      sql`SELECT * FROM omni_memories WHERE id = ${id} AND tenant_id = ${tenantId} LIMIT 1`;
    const rows = options.accessScope
      ? await runWithDatabaseMemoryAccessScope(
          options.accessScope,
          tenantId,
          readRows,
          [
            MEMORY_PURPOSE_IDS.read,
            MEMORY_PURPOSE_IDS.correct,
            MEMORY_PURPOSE_IDS.forget,
          ],
        )
      : await readRows(getSql());
    return rows[0] ? memoryFromRow(rows[0]) : null;
  }
  const memories = await readJsonFile<MemoryRecord[]>(getMemoryFile(), []);
  const memory = memories.find((item) => item.id === id && normalizeTenantId(item.tenantId) === tenantId);
  return memory && memoryVisibleForScope(memory, options.accessScope)
    ? sanitizeMemoryRecord(memory)
    : null;
}

export async function correctMemory(
  id: string,
  correction: { title?: string; content?: string; confidence?: number; validTo?: string; contradiction?: boolean; embedding?: number[] },
  options: {
    tenantId?: string;
    actorId?: string;
    accessScope?: DatabaseMemoryAccessScope;
  } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const existing = await getMemory(id, {
    tenantId,
    accessScope: options.accessScope,
  });
  if (!existing || existing.claimStatus === "forgotten") return null;
  const corrected = await saveMemory({
    tenantId,
    type: existing.type,
    title: correction.title || existing.title,
    content: correction.content || existing.content,
    tags: existing.tags,
    scope: existing.scope,
    source: `correction:${options.actorId || "user"}`,
    importance: existing.importance,
    confidence: correction.confidence ?? existing.confidence ?? 0.7,
    assertedBy: "user",
    evidenceRefs: [...(existing.evidenceRefs || []), `memory:${existing.id}`],
    validFrom: new Date().toISOString(),
    validTo: correction.validTo,
    supersedesId: correction.contradiction ? undefined : existing.id,
    contradictionOfId: correction.contradiction ? existing.id : undefined,
    embedding: correction.embedding,
    accessBinding: existing.accessBinding,
    databaseAccessScope: existing.accessBinding
      ? options.accessScope
      : undefined,
  });
  const oldStatus: NonNullable<MemoryRecord["claimStatus"]> = correction.contradiction ? "contradicted" : "superseded";
  if (hasDatabaseUrl()) {
    const updatePrevious = (sql: MemorySqlClient) =>
      sql`UPDATE omni_memories SET claim_status = ${oldStatus}, valid_to = COALESCE(valid_to, NOW()), updated_at = NOW() WHERE id = ${id} AND tenant_id = ${tenantId} AND claim_status <> 'forgotten'`;
    if (existing.accessBinding) {
      if (!options.accessScope) {
        throw new Error("Scoped memory correction requires an access scope.");
      }
      await runWithDatabaseMemoryAccessScope(
        options.accessScope,
        tenantId,
        updatePrevious,
        [MEMORY_PURPOSE_IDS.correct],
      );
    } else {
      await updatePrevious(getSql());
    }
  } else {
    await updateJsonFile<MemoryRecord[]>(getMemoryFile(), [], (memories) => memories.map((memory) =>
      memory.id === id && normalizeTenantId(memory.tenantId) === tenantId
        ? { ...sanitizeMemoryRecord(memory), claimStatus: oldStatus, validTo: memory.validTo || new Date().toISOString(), updatedAt: new Date().toISOString() }
        : memory,
    ));
  }
  return { previous: { ...existing, claimStatus: oldStatus }, corrected };
}

export type ForgetMemoryWithReceiptResult = {
  memory: MemoryRecord;
  receipt: MemoryDeletionReceiptV1 | null;
  deletionGuarantee:
    | "scope_bound_receipt"
    | "legacy_unattributed_receipt"
    | "best_effort";
  deletionDisposition: "committed" | "already_deleted";
  invalidatedAgentRunCount: number;
  invalidatedWorkflowRunCount: number;
  invalidatedDailyBriefCount: number;
};

export class MemoryDeletionPreviewConflictError extends Error {
  constructor() {
    super("Memory deletion impact changed. Review a fresh preview before forgetting it.");
    this.name = "MemoryDeletionPreviewConflictError";
  }
}

export async function previewMemoryDeletion(
  id: string,
  options: {
    tenantId?: string;
    accessScope?: DatabaseMemoryAccessScope;
  } = {},
): Promise<MemoryDeletionPreviewV1 | null> {
  const tenantId = normalizeTenantId(options.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const buildPreview = async (sql: MemorySqlClient) => {
      await lockMemoryDeletionScope(sql, tenantId, id);
      const memoryRows = await sql`
        SELECT *
        FROM omni_memories
        WHERE tenant_id = ${tenantId}
          AND id = ${id}
        FOR SHARE
      `;
      if (!memoryRows[0]) return null;
      const memory = memoryFromRow(memoryRows[0]);
      const receiptRows = await sql`
        SELECT *
        FROM omni_memory_deletion_receipts
        WHERE tenant_id = ${tenantId}
          AND memory_id = ${id}
      `;
      if (receiptRows[0]) {
        const receipt = memoryDeletionReceiptFromRow(receiptRows[0]);
        return buildMemoryDeletionPreviewV1({
          tenantId,
          state: "already_deleted",
          guarantee: "rollback_proof_barrier",
          memory: previewMemoryRecord(memory),
          descendantMemories: receipt.descendantMemoryIds.map((descendantId) => ({
            id: descendantId,
            title: "[forgotten descendant]",
            type: "knowledge" as const,
          })),
          retrievalTraceIds: receipt.retrievalTraceIds,
          graphNodeIds: receipt.graphNodeIds,
          graphEdgeIds: receipt.graphEdgeIds,
          generatedAt: new Date().toISOString(),
        });
      }
      if (memory.claimStatus === "forgotten") {
        throw new Error("Forgotten memory is missing its immutable deletion receipt.");
      }

      const lineage = await collectMemoryDeletionLineage(sql, tenantId, id, {
        lockTraces: false,
      });
      const pendingRuns = await collectPendingRunsForDeletionPreview(
        sql,
        tenantId,
        lineage.retrievalTraceIds,
      );
      return buildMemoryDeletionPreviewV1({
        tenantId,
        guarantee: "rollback_proof_barrier",
        memory: previewMemoryRecord(memory),
        descendantMemories: lineage.descendantMemories,
        retrievalTraceIds: lineage.retrievalTraceIds,
        graphNodeIds: lineage.graphNodeIds,
        graphEdgeIds: lineage.graphEdgeIds,
        pendingAgentRunIds: pendingRuns.agentRunIds,
        pendingWorkflowRunIds: pendingRuns.workflowRunIds,
      });
    };
    return options.accessScope
      ? runWithDatabaseMemoryAccessScope(
          options.accessScope,
          tenantId,
          buildPreview,
          [MEMORY_PURPOSE_IDS.forget],
        )
      : getSql().transaction(buildPreview) as Promise<MemoryDeletionPreviewV1 | null>;
  }

  const memories = (await readJsonFile<MemoryRecord[]>(getMemoryFile(), []))
    .map(sanitizeMemoryRecord)
    .filter((memory) => normalizeTenantId(memory.tenantId) === tenantId)
    .filter((memory) => memoryVisibleForScope(memory, options.accessScope));
  const memory = memories.find((item) => item.id === id);
  if (!memory) return null;
  const descendantMemories = collectFileMemoryDescendants(memories, id);
  return buildMemoryDeletionPreviewV1({
    tenantId,
    state: memory.claimStatus === "forgotten" ? "already_deleted" : "ready",
    guarantee: "best_effort",
    memory: previewMemoryRecord(memory),
    descendantMemories: descendantMemories.map(previewMemoryRecord),
    retrievalTraceIds: [],
    graphNodeIds: [],
    graphEdgeIds: [],
  });
}

/** Read-only lookup used to reconcile a governed forget after a process loss. */
export async function getMemoryDeletionReceipt(
  id: string,
  options: { tenantId?: string } = {},
): Promise<MemoryDeletionReceiptV1 | null> {
  if (!hasDatabaseUrl()) return null;
  await ensureDatabaseSchema();
  const tenantId = normalizeTenantId(options.tenantId);
  return getSql().transaction(async (sql: MemorySqlClient) => {
    await sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`memory-graph:${tenantId}`}, 0)
      )
    `;
    const rows = await sql`
      SELECT *
      FROM omni_memory_deletion_receipts
      WHERE tenant_id = ${tenantId}
        AND memory_id = ${id}
      LIMIT 1
    `;
    return rows[0] ? memoryDeletionReceiptFromRow(rows[0]) : null;
  }) as Promise<MemoryDeletionReceiptV1 | null>;
}

/**
 * Compatibility facade. Postgres callers must supply a scope; file-backed
 * callers retain the historical best-effort return shape.
 */
export async function forgetMemory(
  id: string,
  options: {
    tenantId?: string;
    executionScope?: ExecutionScope;
    expectedDescendantManifestSha256?: string;
    accessScope?: DatabaseMemoryAccessScope;
  } = {},
) {
  return (await forgetMemoryWithReceipt(id, options))?.memory || null;
}

export async function forgetMemoryWithReceipt(
  id: string,
  options: {
    tenantId?: string;
    executionScope?: ExecutionScope;
    expectedDescendantManifestSha256?: string;
    accessScope?: DatabaseMemoryAccessScope;
  } = {},
): Promise<ForgetMemoryWithReceiptResult | null> {
  const tenantId = normalizeTenantId(options.tenantId);
  const forgottenAt = new Date().toISOString();
  const expectedManifestSha256 = normalizeExpectedDeletionManifest(
    options.expectedDescendantManifestSha256,
  );
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const executionScope = parsePersistedExecutionScope(options.executionScope);
    if (
      !executionScope ||
      !options.executionScope ||
      !executionScopesEqual(executionScope, options.executionScope)
    ) {
      throw new Error("Postgres memory deletion requires an exact execution scope.");
    }
    assertExecutionScopeTenant(executionScope, tenantId);
    if (!executionScope.initiatingActorId) {
      throw new Error("Postgres memory deletion requires a non-null initiating actor.");
    }

    const forgetInTransaction = async (sql: MemorySqlClient) => {
      await lockMemoryDeletionScope(sql, tenantId, id);

      const memoryRows = await sql`
        SELECT *
        FROM omni_memories
        WHERE tenant_id = ${tenantId}
          AND id = ${id}
        FOR UPDATE
      `;
      const receiptRows = await sql`
        SELECT *
        FROM omni_memory_deletion_receipts
        WHERE tenant_id = ${tenantId}
          AND memory_id = ${id}
      `;
      if (receiptRows[0]) {
        const receipt = memoryDeletionReceiptFromRow(receiptRows[0]);
        if (!memoryRows[0]) {
          if (options.accessScope) return null;
          throw new Error(
            "Memory deletion receipt is missing its canonical forgotten shell.",
          );
        }
        assertExpectedDeletionManifest(
          expectedManifestSha256,
          receipt.descendantManifestSha256,
        );
        return {
          memory: memoryFromRow(memoryRows[0]),
          receipt,
          deletionGuarantee: receipt.attributionKind === "scope_bound"
            ? "scope_bound_receipt" as const
            : "legacy_unattributed_receipt" as const,
          deletionDisposition:
            receipt.attributionKind === "scope_bound" &&
              receipt.executionScope &&
              executionScopesEqual(receipt.executionScope, executionScope)
              ? "committed" as const
              : "already_deleted" as const,
          invalidatedAgentRunCount: 0,
          invalidatedWorkflowRunCount: 0,
          invalidatedDailyBriefCount: 0,
        };
      }
      if (!memoryRows[0]) {
        return null;
      }
      if (String(memoryRows[0].claim_status) === "forgotten") {
        throw new Error("Forgotten memory is missing its immutable deletion receipt.");
      }

      const lineage = await collectMemoryDeletionLineage(sql, tenantId, id, {
        lockTraces: true,
      });
      const descendantMemoryIds = lineage.descendantMemories.map(
        (memory) => memory.id,
      );
      const retrievalTraceIds = lineage.retrievalTraceIds;

      const invalidatedRuns = await invalidateRunsForDeletedContext({
        tenantId,
        retrievalTraceIds,
        executionScope,
        sourceKind: "memory",
        sourceReference: id,
        sql,
      });

      const graphNodeIds = lineage.graphNodeIds;
      const graphEdgeIds = lineage.graphEdgeIds;

      const receipt = buildMemoryDeletionReceiptV1({
        tenantId,
        memoryId: id,
        executionScope,
        descendantMemoryIds,
        retrievalTraceIds,
        graphNodeIds,
        graphEdgeIds,
        forgottenAt,
        createdAt: forgottenAt,
      });
      assertExpectedDeletionManifest(
        expectedManifestSha256,
        receipt.descendantManifestSha256,
      );
      const invalidatedDailyBriefCount = await invalidateDailyBriefsForDeletedMemories(
        sql,
        tenantId,
        canonicalizeMemoryDeletionIds([id, ...descendantMemoryIds]),
      );
      // The receipt trigger verifies and deletes this exact graph/trace
      // snapshot before NEW becomes visible to the restrictive barrier policy.
      await insertMemoryDeletionReceipt(receipt, sql);
      const vectorColumnRows = await sql`
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'omni_memories'
          AND column_name = 'embedding_vector'
        LIMIT 1
      `;
      const forgottenRows = vectorColumnRows[0]
        ? await sql`
            UPDATE omni_memories
            SET title = '[forgotten]',
                content = '',
                tags = '{}'::text[],
                source = '[forgotten]',
                embedding = NULL,
                embedding_vector = NULL,
                evidence_refs = '{}'::text[],
                supersedes_id = NULL,
                contradiction_of_id = NULL,
                claim_status = 'forgotten',
                forgotten_at = ${receipt.forgottenAt},
                updated_at = ${receipt.forgottenAt}
            WHERE id = ${id}
              AND tenant_id = ${tenantId}
            RETURNING *
          `
        : await sql`
            UPDATE omni_memories
            SET title = '[forgotten]',
                content = '',
                tags = '{}'::text[],
                source = '[forgotten]',
                embedding = NULL,
                evidence_refs = '{}'::text[],
                supersedes_id = NULL,
                contradiction_of_id = NULL,
                claim_status = 'forgotten',
                forgotten_at = ${receipt.forgottenAt},
                updated_at = ${receipt.forgottenAt}
            WHERE id = ${id}
              AND tenant_id = ${tenantId}
            RETURNING *
          `;
      if (!forgottenRows[0]) {
        throw new Error("Memory disappeared during its deletion transaction.");
      }

      await appendScopedDomainEvent({
        id: memoryForgottenEventId(tenantId, id),
        streamId: `memory:${id}`,
        type: "memory.deletion_barrier.recorded",
        executionScope,
        payload: {
          schemaVersion: receipt.schemaVersion,
          deletionReceiptId: receipt.id,
          memoryId: receipt.memoryId,
          deleteReason: receipt.deleteReason,
          descendantMemoryCount: receipt.descendantMemoryCount,
          retrievalTraceCount: receipt.retrievalTraceCount,
          graphNodeCount: receipt.graphNodeCount,
          graphEdgeCount: receipt.graphEdgeCount,
          invalidatedAgentRunCount: invalidatedRuns.agentRunIds.length,
          invalidatedWorkflowRunCount: invalidatedRuns.workflowRunIds.length,
          invalidatedDailyBriefCount,
          descendantManifestSha256: receipt.descendantManifestSha256,
          executionScopeSha256: receipt.executionScopeSha256,
          receiptSha256: receipt.receiptSha256,
          status: "barrier_committed",
          forgottenAt: receipt.forgottenAt,
        },
      }, { sql });

      await sql`
        INSERT INTO omni_memory_graph_rebuild_queue AS rebuild (
          tenant_id, requested_at, attempts, last_error, updated_at, generation
        )
        VALUES (${tenantId}, NOW(), 0, NULL, NOW(), 1)
        ON CONFLICT (tenant_id) DO UPDATE SET
          requested_at = NOW(),
          attempts = 0,
          last_error = NULL,
          updated_at = NOW(),
          generation = rebuild.generation + 1
      `;

      return {
        memory: memoryFromRow(forgottenRows[0]),
        receipt,
        deletionGuarantee: "scope_bound_receipt" as const,
        deletionDisposition: "committed" as const,
        invalidatedAgentRunCount: invalidatedRuns.agentRunIds.length,
        invalidatedWorkflowRunCount: invalidatedRuns.workflowRunIds.length,
        invalidatedDailyBriefCount,
      };
    };
    return options.accessScope
      ? runWithDatabaseMemoryAccessScope(
          options.accessScope,
          tenantId,
          forgetInTransaction,
          [MEMORY_PURPOSE_IDS.forget],
        )
      : getSql().transaction(forgetInTransaction) as Promise<ForgetMemoryWithReceiptResult | null>;
  }
  const filePreview = await previewMemoryDeletion(id, {
    tenantId,
    accessScope: options.accessScope,
  });
  if (!filePreview) return null;
  if (expectedManifestSha256) {
    assertExpectedDeletionManifest(
      expectedManifestSha256,
      filePreview.expectedReceiptManifestSha256,
    );
  }
  const affectedFileMemoryIds = new Set([
    id,
    ...filePreview.descendantMemories.map((memory) => memory.id),
  ]);
  let forgotten: MemoryRecord | null = null;
  let deletionDisposition: ForgetMemoryWithReceiptResult["deletionDisposition"] =
    "committed";
  await updateJsonFile<MemoryRecord[]>(
    getMemoryFile(),
    [],
    (memories) => memories.map((memory) => {
      if (
        !affectedFileMemoryIds.has(memory.id) ||
        normalizeTenantId(memory.tenantId) !== tenantId
      ) {
        return memory;
      }
      const sanitized = sanitizeMemoryRecord(memory);
      if (memory.id === id) {
        deletionDisposition = sanitized.claimStatus === "forgotten"
          ? "already_deleted"
          : "committed";
      }
      const effectiveForgottenAt = sanitized.forgottenAt || forgottenAt;
      const scrubbed: MemoryRecord = {
        ...sanitized,
        title: "[forgotten]",
        content: "",
        tags: [],
        source: "[forgotten]",
        embedding: undefined,
        evidenceRefs: [],
        supersedesId: undefined,
        contradictionOfId: undefined,
        claimStatus: "forgotten",
        forgottenAt: effectiveForgottenAt,
        updatedAt: effectiveForgottenAt,
      };
      if (memory.id === id) forgotten = scrubbed;
      return scrubbed;
    }),
  );
  if (!forgotten) return null;
  const { queueMemoryGraphRebuild } = await import("@/lib/memory/graph");
  await queueMemoryGraphRebuild({ tenantId });
  return {
    memory: forgotten,
    receipt: null,
    deletionGuarantee: "best_effort",
    deletionDisposition,
    invalidatedAgentRunCount: 0,
    invalidatedWorkflowRunCount: 0,
    invalidatedDailyBriefCount: 0,
  };
}

async function invalidateDailyBriefsForDeletedMemories(
  sql: MemorySqlClient,
  tenantId: string,
  memoryIds: readonly string[],
) {
  const rows = await sql`
    DELETE FROM omni_daily_briefs brief
    WHERE brief.tenant_id = ${tenantId}
      AND (
        brief.memory_ids && ${memoryIds}::text[]
        OR (
          cardinality(brief.memory_ids) = 0
          AND jsonb_typeof(brief.source_counts -> 'memories') = 'number'
          AND (brief.source_counts ->> 'memories')::numeric > 0
        )
      )
    RETURNING brief.id
  `;
  return rows.length;
}

async function lockMemoryDeletionScope(
  sql: MemorySqlClient,
  tenantId: string,
  memoryId: string,
) {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`memory-graph:${tenantId}`}, 0)
    )
  `;
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${tenantId}),
      hashtext(${`memory:${memoryId}`})
    )
  `;
}

async function collectMemoryDeletionLineage(
  sql: MemorySqlClient,
  tenantId: string,
  memoryId: string,
  options: { lockTraces: boolean },
) {
  const descendantRows = await sql`
    WITH RECURSIVE descendants(id) AS (
      SELECT child.id
      FROM omni_memories child
      WHERE child.tenant_id = ${tenantId}
        AND child.id <> ${memoryId}
        AND (
          child.supersedes_id = ${memoryId}
          OR child.contradiction_of_id = ${memoryId}
          OR ${`memory:${memoryId}`} = ANY(child.evidence_refs)
        )
      UNION
      SELECT child.id
      FROM omni_memories child
      JOIN descendants parent ON (
        child.supersedes_id = parent.id
        OR child.contradiction_of_id = parent.id
        OR ('memory:' || parent.id) = ANY(child.evidence_refs)
      )
      WHERE child.tenant_id = ${tenantId}
        AND child.id <> ${memoryId}
    )
    SELECT memory.id, memory.title, memory.type
    FROM descendants
    JOIN omni_memories memory
      ON memory.tenant_id = ${tenantId}
      AND memory.id = descendants.id
    ORDER BY memory.id COLLATE "C"
  `;
  const descendantMemories = descendantRows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    type: normalizeMemoryType(row.type),
  }));
  const affectedMemoryIds = canonicalizeMemoryDeletionIds([
    memoryId,
    ...descendantMemories.map((memory) => memory.id),
  ]);
  const traceRows = options.lockTraces
    ? await sql`
        SELECT id
        FROM omni_retrieval_traces trace
        WHERE trace.tenant_id = ${tenantId}
          AND (
            trace.memory_ids && ${affectedMemoryIds}::text[]
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(trace.results) = 'array'
                    THEN trace.results
                  ELSE '[]'::jsonb
                END
              ) result
              WHERE result ->> 'kind' = 'memory'
                AND result ->> 'id' = ANY(${affectedMemoryIds}::text[])
            )
          )
        ORDER BY id COLLATE "C"
        FOR UPDATE
      `
    : await sql`
        SELECT id
        FROM omni_retrieval_traces trace
        WHERE trace.tenant_id = ${tenantId}
          AND (
            trace.memory_ids && ${affectedMemoryIds}::text[]
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(trace.results) = 'array'
                    THEN trace.results
                  ELSE '[]'::jsonb
                END
              ) result
              WHERE result ->> 'kind' = 'memory'
                AND result ->> 'id' = ANY(${affectedMemoryIds}::text[])
            )
          )
        ORDER BY id COLLATE "C"
        FOR SHARE
      `;
  const retrievalTraceIds = canonicalizeMemoryDeletionIds(
    traceRows.map((row) => String(row.id)),
  );
  const graphNodeRows = await sql`
    SELECT id
    FROM omni_memory_graph_nodes node
    WHERE node.tenant_id = ${tenantId}
      AND (
        node.memory_ids && ${affectedMemoryIds}::text[]
        OR node.trace_ids && ${retrievalTraceIds}::text[]
      )
    ORDER BY id COLLATE "C"
  `;
  const graphNodeIds = canonicalizeMemoryDeletionIds(
    graphNodeRows.map((row) => String(row.id)),
  );
  const graphEdgeRows = await sql`
    SELECT id
    FROM omni_memory_graph_edges edge
    WHERE edge.tenant_id = ${tenantId}
      AND (
        edge.memory_ids && ${affectedMemoryIds}::text[]
        OR edge.trace_ids && ${retrievalTraceIds}::text[]
        OR edge.source_node_id = ANY(${graphNodeIds}::text[])
        OR edge.target_node_id = ANY(${graphNodeIds}::text[])
      )
    ORDER BY id COLLATE "C"
  `;
  return {
    descendantMemories,
    retrievalTraceIds,
    graphNodeIds,
    graphEdgeIds: canonicalizeMemoryDeletionIds(
      graphEdgeRows.map((row) => String(row.id)),
    ),
  };
}

async function collectPendingRunsForDeletionPreview(
  sql: MemorySqlClient,
  tenantId: string,
  retrievalTraceIds: readonly string[],
) {
  if (!retrievalTraceIds.length) {
    return { agentRunIds: [] as string[], workflowRunIds: [] as string[] };
  }
  const agentRows = await sql`
      SELECT run.id
      FROM omni_agent_runs run
      WHERE run.tenant_id = ${tenantId}
        AND run.status IN ('running', 'waiting_approval', 'resuming')
        AND EXISTS (
          SELECT 1
          FROM omni_agent_events event
          WHERE event.tenant_id = run.tenant_id
            AND event.run_id = run.id
            AND event.type = 'harness'
            AND event.payload ->> 'contextTraceId' = ANY(${retrievalTraceIds}::text[])
        )
      ORDER BY run.id COLLATE "C"
    `;
  const workflowRows = await sql`
      SELECT run.id
      FROM omni_workflow_runs run
      WHERE run.tenant_id = ${tenantId}
        AND run.status IN ('queued', 'running', 'waiting_approval', 'paused')
        AND EXISTS (
          SELECT 1
          FROM omni_workflow_plans plan
          WHERE plan.tenant_id = run.tenant_id
            AND plan.workflow_run_id = run.id
            AND plan.context_trace_id = ANY(${retrievalTraceIds}::text[])
        )
      ORDER BY run.id COLLATE "C"
    `;
  return {
    agentRunIds: canonicalizeMemoryDeletionIds(
      agentRows.map((row) => String(row.id)),
    ),
    workflowRunIds: canonicalizeMemoryDeletionIds(
      workflowRows.map((row) => String(row.id)),
    ),
  };
}

function collectFileMemoryDescendants(
  memories: readonly MemoryRecord[],
  rootId: string,
) {
  const descendants: MemoryRecord[] = [];
  const discovered = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const memory of memories) {
      if (discovered.has(memory.id)) continue;
      const referencesAncestor = [...discovered].some((ancestorId) =>
        memory.supersedesId === ancestorId ||
        memory.contradictionOfId === ancestorId ||
        memory.evidenceRefs?.includes(`memory:${ancestorId}`)
      );
      if (!referencesAncestor) continue;
      discovered.add(memory.id);
      descendants.push(memory);
      changed = true;
    }
  }
  return descendants.sort((left, right) =>
    Buffer.from(left.id, "utf8").compare(Buffer.from(right.id, "utf8"))
  );
}

function previewMemoryRecord(memory: MemoryRecord) {
  return {
    id: memory.id,
    title: memory.title,
    type: memory.type,
  };
}

function normalizeMemoryType(value: unknown): MemoryType {
  const type = String(value);
  return [
    "preference",
    "fact",
    "episode",
    "procedure",
    "knowledge",
    "decision",
    "task",
  ].includes(type)
    ? type as MemoryType
    : "knowledge";
}

function normalizeExpectedDeletionManifest(value: string | undefined) {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("Memory deletion preview digest is invalid.");
  }
  return normalized;
}

function assertExpectedDeletionManifest(
  expected: string | undefined,
  actual: string | null,
) {
  if (expected && expected !== actual) {
    throw new MemoryDeletionPreviewConflictError();
  }
}

/**
 * Close the run-feedback loop without deleting evidence. Positive feedback
 * raises confidence modestly; a correction quarantines agent-authored claims
 * from retrieval until the owner reviews or replaces them.
 */
export async function applyRunMemoryFeedback(
  runId: string,
  verdict: "useful" | "needs_work",
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const evidenceRef = `run:${runId}`;
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = verdict === "useful"
      ? await getSql()`
          UPDATE omni_memories
          SET confidence = LEAST(0.95, confidence + 0.10),
              tags = ARRAY(SELECT DISTINCT unnest(tags || ARRAY['owner-verified']::text[])),
              updated_at = ${now}
          WHERE tenant_id = ${tenantId}
            AND asserted_by = 'agent'
            AND claim_status = 'active'
            AND ${evidenceRef} = ANY(evidence_refs)
            AND NOT ('owner-verified' = ANY(tags))
          RETURNING id
        `
      : await getSql()`
          UPDATE omni_memories
          SET confidence = LEAST(confidence, 0.35),
              claim_status = 'contradicted',
              valid_to = COALESCE(valid_to, ${now}),
              tags = ARRAY(SELECT DISTINCT unnest(tags || ARRAY['needs-review', 'run-corrected']::text[])),
              updated_at = ${now}
          WHERE tenant_id = ${tenantId}
            AND asserted_by = 'agent'
            AND claim_status = 'active'
            AND ${evidenceRef} = ANY(evidence_refs)
          RETURNING id
        `;
    return rows.map((row) => String(row.id));
  }

  const changed: string[] = [];
  await updateJsonFile<MemoryRecord[]>(getMemoryFile(), [], (memories) => memories.map((raw) => {
    const memory = sanitizeMemoryRecord(raw);
    if (
      normalizeTenantId(memory.tenantId) !== tenantId ||
      memory.assertedBy !== "agent" ||
      memory.claimStatus !== "active" ||
      !memory.evidenceRefs?.includes(evidenceRef) ||
      (verdict === "useful" && memory.tags.includes("owner-verified"))
    ) return raw;
    changed.push(memory.id);
    return verdict === "useful"
      ? {
          ...memory,
          confidence: Math.min(0.95, (memory.confidence ?? 0.7) + 0.1),
          tags: normalizeTags([...memory.tags, "owner-verified"]),
          updatedAt: now,
        }
      : {
          ...memory,
          confidence: Math.min(memory.confidence ?? 0.7, 0.35),
          claimStatus: "contradicted" as const,
          validTo: memory.validTo || now,
          tags: normalizeTags([...memory.tags, "needs-review", "run-corrected"]),
          updatedAt: now,
        };
  }));
  return changed;
}

export async function getMemoryStats(options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT type, COUNT(*)::int AS count
      FROM omni_memories
      WHERE tenant_id = ${tenantId}
      GROUP BY type
    `;
    const byType = rows.reduce<Record<string, number>>((acc, row) => {
      acc[String(row.type)] = Number(row.count);
      return acc;
    }, {});
    const total = Object.values(byType).reduce((sum, count) => sum + count, 0);
    const embeddedRows = await getSql()`
      SELECT COUNT(*)::int AS count
      FROM omni_memories
      WHERE jsonb_typeof(embedding) = 'array'
        AND tenant_id = ${tenantId}
    `;

    return {
      total,
      byType,
      embedded: Number(embeddedRows[0]?.count || 0),
    };
  }

  const memories = await listMemories({ tenantId });
  const byType = memories.reduce<Record<string, number>>((acc, memory) => {
    acc[memory.type] = (acc[memory.type] || 0) + 1;
    return acc;
  }, {});

  return {
    total: memories.length,
    byType,
    embedded: memories.filter((memory) => memory.embedding?.length).length,
  };
}

async function searchMemoriesDb(
  query: string,
  options: { limit?: number; queryEmbedding?: number[]; tenantId?: string },
): Promise<MemorySearchResult[]> {
  await ensureDatabaseSchema();
  const limit = options.limit || 8;
  const queryText = query.trim();
  const tenantId = normalizeTenantId(options.tenantId);
  const vector = toVectorLiteral(options.queryEmbedding);

  if (vector) {
    try {
      const rows = await getSql()`
        SELECT *,
               GREATEST(0, 1 - (embedding_vector <=> ${vector}::vector)) AS vector_score,
               CASE
                 WHEN ${queryText} = '' THEN 0
                 ELSE ts_rank_cd(
                   to_tsvector('english', title || ' ' || content),
                   plainto_tsquery('english', ${queryText})
                 )
               END AS lexical_score,
               1 / (1 + EXTRACT(EPOCH FROM (NOW() - updated_at)) / 604800) AS recency_score
        FROM omni_memories
        WHERE tenant_id = ${tenantId}
          AND claim_status = 'active'
          AND (valid_from IS NULL OR valid_from <= NOW())
          AND (valid_to IS NULL OR valid_to > NOW())
          AND embedding_vector IS NOT NULL
        ORDER BY (
          (0.52 * GREATEST(0, 1 - (embedding_vector <=> ${vector}::vector))) +
          (0.22 * CASE
            WHEN ${queryText} = '' THEN 0
            ELSE ts_rank_cd(
              to_tsvector('english', title || ' ' || content),
              plainto_tsquery('english', ${queryText})
            )
          END) +
          (0.10 * importance) +
          (0.06 * (1 / (1 + EXTRACT(EPOCH FROM (NOW() - updated_at)) / 604800))) +
          (0.10 * confidence)
        ) DESC
        LIMIT ${limit}
      `;
      return rows.map(memorySearchResultFromRow);
    } catch {
      return searchMemoriesLexicalDb(queryText, limit, tenantId);
    }
  }

  return searchMemoriesLexicalDb(queryText, limit, tenantId);
}

async function searchMemoriesLexicalDb(query: string, limit: number, tenantId: string) {
  const rows = await getSql()`
    SELECT ranked.*
    FROM (
      SELECT *,
             CASE
               WHEN ${query} = '' THEN 0
               ELSE ts_rank_cd(
                 to_tsvector('english', title || ' ' || content),
                 plainto_tsquery('english', ${query})
               )
             END AS lexical_score,
             1 / (1 + EXTRACT(EPOCH FROM (NOW() - updated_at)) / 604800) AS recency_score
      FROM omni_memories
      WHERE tenant_id = ${tenantId}
        AND claim_status = 'active'
        AND (valid_from IS NULL OR valid_from <= NOW())
        AND (valid_to IS NULL OR valid_to > NOW())
        AND (
          ${query} = ''
          OR to_tsvector('english', title || ' ' || content) @@ plainto_tsquery('english', ${query})
        )
    ) ranked
    ORDER BY (ranked.lexical_score * (0.35 + ranked.confidence * 0.65)) DESC,
             ranked.importance DESC,
             ranked.updated_at DESC
    LIMIT ${limit}
  `;

  return rows.map(memorySearchResultFromRow);
}

async function runWithDatabaseMemoryAccessScope<T>(
  accessScope: DatabaseMemoryAccessScope,
  tenantId: string,
  operation: (sql: MemorySqlClient) => Promise<T>,
  allowedPurposeIds: readonly string[],
): Promise<T> {
  const parsedScope = parseDatabaseMemoryAccessScope(accessScope);
  if (
    parsedScope.tenantId !== tenantId ||
    !allowedPurposeIds.includes(parsedScope.purposeId)
  ) {
    throw new Error("Memory access scope does not match this operation.");
  }
  return getSql().transaction(async (sql: MemorySqlClient) => {
    await setTransactionLocalDatabaseMemoryAccessScope(sql, parsedScope);
    return operation(sql);
  }) as Promise<T>;
}

function resolveDatabaseMemoryWriteScope(
  inputs: readonly CreateMemoryInput[],
  records: readonly MemoryRecord[],
  tenantId: string,
): DatabaseMemoryAccessScope | undefined {
  const hasBinding = records.some((record) => Boolean(record.accessBinding));
  const hasDatabaseScope = inputs.some((input) => Boolean(input.databaseAccessScope));
  if (!hasBinding && !hasDatabaseScope) return undefined;
  if (!hasDatabaseUrl() && hasBinding && !hasDatabaseScope) return undefined;
  if (
    inputs.length !== records.length ||
    inputs.some((input, index) =>
      Boolean(input.databaseAccessScope) !== Boolean(records[index]?.accessBinding)
    )
  ) {
    throw new Error(
      "Every scope-bound memory write requires one matching database scope.",
    );
  }

  const firstScope = parseDatabaseMemoryAccessScope(
    inputs[0]?.databaseAccessScope,
  );
  const serializedScope = serializeDatabaseMemoryAccessScope(firstScope);
  const writePurposes = new Set<string>([
    MEMORY_PURPOSE_IDS.write,
    MEMORY_PURPOSE_IDS.correct,
    MEMORY_PURPOSE_IDS.formation,
  ]);
  if (
    firstScope.tenantId !== tenantId ||
    !writePurposes.has(firstScope.purposeId)
  ) {
    throw new Error("Memory write scope is not authorized for this operation.");
  }

  for (let index = 0; index < records.length; index += 1) {
    const binding = records[index]?.accessBinding;
    const scope = parseDatabaseMemoryAccessScope(
      inputs[index]?.databaseAccessScope,
    );
    if (
      !binding ||
      binding.visibility !== "user_private" ||
      serializeDatabaseMemoryAccessScope(scope) !== serializedScope ||
      !memoryAccessBindingAllows(scope, binding)
    ) {
      throw new Error("Memory access binding does not authorize this write.");
    }
  }
  return firstScope;
}

async function updateInsertedMemoryVectors(
  sql: MemorySqlClient,
  rows: readonly Record<string, unknown>[],
  records: readonly MemoryRecord[],
  tenantId: string,
) {
  const insertedVectors = rows
    .filter((row) => Boolean(row._inserted))
    .map((row) => {
      const record = records.find((item) => item.id === String(row.id));
      const embedding = toVectorLiteral(record?.embedding);
      return embedding ? { id: String(row.id), embedding } : null;
    })
    .filter(
      (item): item is { id: string; embedding: string } => Boolean(item),
    );
  if (!insertedVectors.length) return;
  try {
    await sql`
      UPDATE omni_memories memory
      SET embedding_vector = vectors.embedding::vector
      FROM jsonb_to_recordset(${insertedVectors}::jsonb) AS vectors(
        id text,
        embedding text
      )
      WHERE memory.id = vectors.id
        AND memory.tenant_id = ${tenantId}
    `;
  } catch {
    // pgvector is optional; JSON embeddings remain available.
  }
}

function memoryFromRow(row: Record<string, unknown>): MemoryRecord {
  const accessBinding = memoryAccessBindingFromRow(row);
  return sanitizeMemoryRecord({
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
    type: String(row.type) as MemoryType,
    title: String(row.title || ""),
    content: String(row.content || ""),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    scope: String(row.scope || "workspace") as MemoryRecord["scope"],
    source: String(row.source || "database"),
    importance: Number(row.importance ?? 0.5),
    confidence: Number(row.confidence ?? 0.7),
    claimStatus: normalizeClaimStatus(row.claim_status),
    assertedBy: normalizeAssertedBy(row.asserted_by),
    evidenceRefs: Array.isArray(row.evidence_refs) ? row.evidence_refs.map(String) : [],
    validFrom: row.valid_from ? normalizeDate(row.valid_from) : undefined,
    validTo: row.valid_to ? normalizeDate(row.valid_to) : undefined,
    supersedesId: row.supersedes_id ? String(row.supersedes_id) : undefined,
    contradictionOfId: row.contradiction_of_id ? String(row.contradiction_of_id) : undefined,
    forgottenAt: row.forgotten_at ? normalizeDate(row.forgotten_at) : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
    embedding: parseEmbedding(row.embedding),
    ...(accessBinding ? { accessBinding } : {}),
  });
}

function memoryAccessBindingFromRow(
  row: Record<string, unknown>,
): MemoryAccessBindingV1 | undefined {
  const version = Number(row.access_contract_version || 0);
  if (version === 0) return undefined;
  if (version !== 1) {
    throw new Error("Memory row uses an unsupported access contract.");
  }
  return memoryAccessBindingV1Schema.parse({
    version,
    state: row.access_state,
    tenantId: row.tenant_id,
    ownerActorId: row.owner_actor_id,
    ownerAgentId: row.owner_agent_id ?? null,
    workspaceId: row.workspace_id ?? null,
    projectId: row.project_id ?? null,
    missionId: row.mission_id ?? null,
    visibility: row.visibility,
    sensitivity: row.sensitivity,
    originPurpose: row.origin_purpose,
    allowedPurposeIds: row.allowed_purpose_ids,
    accessScopeSha256: row.access_scope_sha256,
    accessBoundAt: normalizeDate(row.access_bound_at),
  });
}

function memoryDeletionReceiptFromRow(
  row: Record<string, unknown>,
): MemoryDeletionReceiptV1 {
  return parseMemoryDeletionReceiptV1({
    schemaVersion: Number(row.schema_version),
    contractKind: String(row.contract_kind),
    id: String(row.id),
    tenantId: String(row.tenant_id),
    memoryId: String(row.memory_id),
    attributionKind: String(row.attribution_kind),
    initiatingActorId: nullableString(row.initiating_actor_id),
    executingPrincipalType: nullableString(row.executing_principal_type),
    executingPrincipalId: nullableString(row.executing_principal_id),
    correlationId: nullableString(row.correlation_id),
    causationId: nullableString(row.causation_id),
    purpose: nullableString(row.purpose),
    executionScope: row.execution_scope ?? null,
    executionScopeSha256: nullableString(row.execution_scope_sha256),
    receiptSha256: nullableString(row.receipt_sha256),
    deleteReason: String(row.delete_reason),
    descendantMemoryIds: textArray(row.descendant_memory_ids),
    retrievalTraceIds: textArray(row.retrieval_trace_ids),
    graphNodeIds: textArray(row.graph_node_ids),
    graphEdgeIds: textArray(row.graph_edge_ids),
    descendantMemoryCount: Number(row.descendant_memory_count),
    retrievalTraceCount: Number(row.retrieval_trace_count),
    graphNodeCount: Number(row.graph_node_count),
    graphEdgeCount: Number(row.graph_edge_count),
    descendantManifestSha256: nullableString(row.descendant_manifest_sha256),
    forgottenAt: canonicalTimestamp(row.forgotten_at),
    createdAt: canonicalTimestamp(row.created_at),
  });
}

async function insertMemoryDeletionReceipt(
  receipt: MemoryDeletionReceiptV1,
  sql: MemorySqlClient,
) {
  await sql`
    INSERT INTO omni_memory_deletion_receipts (
      id, schema_version, contract_kind, tenant_id, memory_id,
      attribution_kind, initiating_actor_id, executing_principal_type,
      executing_principal_id, correlation_id, causation_id, purpose,
      execution_scope, execution_scope_sha256, receipt_sha256, delete_reason,
      descendant_memory_ids, retrieval_trace_ids, graph_node_ids,
      graph_edge_ids, descendant_memory_count, retrieval_trace_count,
      graph_node_count, graph_edge_count, descendant_manifest_sha256,
      forgotten_at, created_at
    ) VALUES (
      ${receipt.id}, ${receipt.schemaVersion}, ${receipt.contractKind},
      ${receipt.tenantId}, ${receipt.memoryId}, ${receipt.attributionKind},
      ${receipt.initiatingActorId}, ${receipt.executingPrincipalType},
      ${receipt.executingPrincipalId}, ${receipt.correlationId},
      ${receipt.causationId}, ${receipt.purpose},
      ${receipt.executionScope}::jsonb, ${receipt.executionScopeSha256},
      ${receipt.receiptSha256}, ${receipt.deleteReason},
      ${receipt.descendantMemoryIds}::text[],
      ${receipt.retrievalTraceIds}::text[], ${receipt.graphNodeIds}::text[],
      ${receipt.graphEdgeIds}::text[], ${receipt.descendantMemoryCount},
      ${receipt.retrievalTraceCount}, ${receipt.graphNodeCount},
      ${receipt.graphEdgeCount}, ${receipt.descendantManifestSha256},
      ${receipt.forgottenAt}, ${receipt.createdAt}
    )
  `;
}

function textArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

function canonicalTimestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Memory deletion receipt has an invalid timestamp.");
  }
  return date.toISOString();
}

function memoryForgottenEventId(tenantId: string, memoryId: string) {
  return `memory_forgotten_${memoryDeletionContractSha256({
    tenantId,
    memoryId,
  }).slice(0, 56)}`;
}

function sanitizeMemoryRecord(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    confidence: clamp01(record.confidence ?? 0.7),
    claimStatus: normalizeClaimStatus(record.claimStatus),
    assertedBy: normalizeAssertedBy(record.assertedBy),
    evidenceRefs: normalizeEvidenceRefs(record.evidenceRefs || []),
    title: String(redactSensitive(record.title)).slice(0, 240),
    content: String(redactSensitive(record.content)).slice(0, 200_000),
    tags: normalizeTags(
      record.tags.map((tag) => String(redactSensitive(tag))),
    ),
    source: String(redactSensitive(record.source)).slice(0, 2_000),
  };
}

function memoryVisibleForScope(
  record: MemoryRecord,
  accessScope?: DatabaseMemoryAccessScope,
) {
  if (!record.accessBinding) return !accessScope;
  return accessScope
    ? memoryAccessBindingAllows(accessScope, record.accessBinding)
    : false;
}

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}

function memorySearchResultFromRow(row: Record<string, unknown>): MemorySearchResult {
  const vectorScore = Number(row.vector_score || 0);
  const lexicalScore = Number(row.lexical_score || 0);
  const recencyScore = Number(row.recency_score || 0);
  const memory = memoryFromRow(row);
  const confidence = clamp01(memory.confidence ?? 0.7);
  const score = vectorScore * 0.52 + lexicalScore * 0.22 + memory.importance * 0.10 + recencyScore * 0.06 + confidence * 0.10;

  return {
    record: memory,
    score,
    reasons: [
      vectorScore > 0.2 ? "semantic match" : "",
      lexicalScore > 0 ? "keyword match" : "",
      memory.importance >= 0.8 ? "high importance" : "",
      recencyScore > 0.5 ? "recent memory" : "",
      confidence >= 0.85 ? "high-confidence claim" : confidence < 0.5 ? "low-confidence claim" : "",
    ].filter(Boolean),
  };
}

function getMemoryFile() {
  return getDataPath("memory.json");
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeTags(tags: string[]) {
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 12),
    ),
  );
}

function normalizeEvidenceRefs(refs: string[]) {
  return Array.from(new Set(refs.map((ref) => String(redactSensitive(ref)).trim().slice(0, 500)).filter(Boolean))).slice(0, 50);
}

function normalizeOptionalDate(value?: string) {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizeOptionalId(value?: string) {
  return value?.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 200) || undefined;
}

function normalizeClaimStatus(value: unknown): NonNullable<MemoryRecord["claimStatus"]> {
  return value === "superseded" || value === "contradicted" || value === "forgotten" ? value : "active";
}

function normalizeAssertedBy(value: unknown): NonNullable<MemoryRecord["assertedBy"]> {
  return value === "user" || value === "agent" || value === "import" ? value : "system";
}

function isActiveMemory(memory: MemoryRecord) {
  if (memory.claimStatus !== "active") return false;
  return isTemporalIntervalActive(memory, Date.now());
}

function clamp01(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.7;
}

function tokenize(value: string) {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((term) => term.length > 2),
    ),
  );
}
