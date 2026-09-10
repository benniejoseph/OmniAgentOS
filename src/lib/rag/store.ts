import { createHash, randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { retireEntityEvidenceLineage } from "@/lib/entities/store";
import { queueTemporalRelationProjection } from "@/lib/entities/relation-projection-queue";
import { getDataPath } from "@/lib/storage/paths";
import { redactSensitive } from "@/lib/security/context";
import {
  assertExecutionScopeTenant,
  deriveExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { cosineSimilarity, parseEmbedding, toVectorLiteral } from "@/lib/rag/vector";
import {
  embedLocalMultilingualTexts,
  isLocalRetrievalEmbeddingSpace,
  retrievalEmbeddingCosine,
  retrievalEmbeddingSpaceSupportsStoredVectorIndex,
} from "@/lib/rag/retrieval-embedding";
import { normalizeTextForChunking } from "@/lib/rag/chunk";
import { jsonbSafeTruncate } from "@/lib/rag/text-safety";
import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeLedger,
  KnowledgeSearchResult,
  KnowledgeSourceType,
} from "@/lib/rag/types";
import type { MemoryRecord } from "@/lib/memory/types";
import {
  assertCaptureIngestSource,
  captureIngestSource,
  lockActiveCaptureIngest,
  type CaptureIngestGuard,
} from "@/lib/capture/ingest-guard";
import {
  sourceAdapterUpsertV1Schema,
  sourceContractSha256,
  type EvidenceUnitV1,
  type SourceAdapterUpsertV1,
} from "@/lib/sources/contracts";
import {
  assertCanonicalAdapterOutputReceipt,
  evidenceUnitFromStoredRow,
  mergeCanonicalSourceLedger,
  persistCanonicalSourceWrite,
  storedAdapterEnvelopeMatches,
  type PersistedKnowledgeLineage,
} from "@/lib/sources/store";
import type { CanonicalTextSourceWrite } from "@/lib/sources/text-lineage";
import {
  KNOWLEDGE_DELETION_EVENT_SCHEMA_VERSION,
  knowledgeDeletionEventId,
  knowledgeDeletionEventPayloadSchema,
  knowledgeDeletionSha256,
  knowledgeDeletionTargetId,
  type KnowledgeDeletionMutationContext,
} from "@/lib/rag/deletion-events";
import { invalidateRunsForDeletedContext } from "@/lib/runs/context-invalidation";
import { buildCaptureKnowledgeSupersessionEvent } from "@/lib/rag/capture-supersession-event";
import { KNOWLEDGE_COGNIFY_PURPOSE_ID } from "@/lib/sources/purposes";
import { purgeKnowledgeCognitionsForDocuments } from "@/lib/knowledge/cognification-store";

type RagSqlClient = ReturnType<typeof getSql>;

export type CanonicalKnowledgeEvidence = Readonly<{
  chunk: KnowledgeChunk;
  evidenceUnit: EvidenceUnitV1;
  sourceState: Readonly<{
    currentRevisionId: string | null;
    operation: "upsert" | "delete";
    isCurrent: boolean;
  }>;
}>;

type CreateKnowledgeDocumentInput = {
  idempotencyKey?: string;
  tenantId?: string;
  title: string;
  content: string;
  source?: string;
  sourceType?: KnowledgeSourceType;
  tags?: string[];
  chunks: Array<{
    index: number;
    content: string;
    embedding?: number[];
    label?: string;
    metadata?: Record<string, unknown>;
  }>;
  metadata?: Record<string, unknown>;
  canonicalSourceWrite?: CanonicalTextSourceWrite;
  captureIngestGuard?: CaptureIngestGuard;
};

type SearchKnowledgeOptions = {
  limit?: number;
  queryEmbedding?: number[];
  queryEmbeddingSpaceId?: string;
  tags?: string[];
  tenantId?: string;
};

export async function createKnowledgeDocument(input: CreateKnowledgeDocumentInput) {
  const now = new Date().toISOString();
  const safeTitle = jsonbSafeTruncate(
    String(redactSensitive(input.title.trim())),
    240,
  );
  const safeContent = jsonbSafeTruncate(
    String(redactSensitive(input.content)),
    900_000,
  );
  const tags = normalizeTags(
    ["rag", ...(input.tags || [])].map((tag) =>
      String(redactSensitive(tag)),
    ),
  );
  const source =
    jsonbSafeTruncate(
      String(redactSensitive(input.source?.trim() || "manual")),
      2_000,
    );
  const tenantId = normalizeTenantId(input.tenantId);
  const documentId = input.idempotencyKey
    ? knowledgeDocumentId(tenantId, input.idempotencyKey)
    : randomUUID();
  const canonicalSourceWrite = input.canonicalSourceWrite;
  if (input.captureIngestGuard) {
    assertCaptureIngestSource(input.captureIngestGuard, tenantId, source);
  }
  if (
    canonicalSourceWrite &&
    canonicalSourceWrite.executionScope.tenantId !== tenantId
  ) {
    throw new Error(
      "Canonical source lineage tenant does not match the knowledge document.",
    );
  }
  if (
    canonicalSourceWrite &&
    canonicalSourceWrite.evidenceUnitIdsByChunkIndex.length !==
      input.chunks.length
  ) {
    throw new Error(
      "Canonical source lineage must bind every knowledge chunk to evidence.",
    );
  }
  const document: KnowledgeDocument = {
    id: documentId,
    tenantId,
    ...(canonicalSourceWrite
      ? {
          sourceItemId:
            canonicalSourceWrite.adapterOutput.sourceItem.sourceItemId,
          sourceRevisionId:
            canonicalSourceWrite.adapterOutput.sourceRevision.sourceRevisionId,
        }
      : {}),
    title: safeTitle,
    source,
    sourceType: input.sourceType || inferSourceType(source),
    tags,
    contentHash: hashContent(safeContent),
    chunkCount: input.chunks.length,
    totalCharacters: safeContent.length,
    metadata: redactSensitive(input.metadata || {}) as Record<string, unknown>,
    createdAt: now,
    updatedAt: now,
  };
  const chunks: KnowledgeChunk[] = input.chunks.map((chunk) => {
    const safeChunkContent = jsonbSafeTruncate(
      String(redactSensitive(chunk.content)),
      900_000,
    );
    return {
      id: input.idempotencyKey
        ? `${documentId}_chunk_${chunk.index}`
        : randomUUID(),
      tenantId,
      documentId: document.id,
      ...(canonicalSourceWrite
        ? {
            sourceRevisionId:
              canonicalSourceWrite.adapterOutput.sourceRevision.sourceRevisionId,
            evidenceUnitId:
              canonicalSourceWrite.evidenceUnitIdsByChunkIndex[chunk.index],
          }
        : {}),
      chunkIndex: chunk.index,
      title:
        chunk.label
          ? `${document.title} — ${jsonbSafeTruncate(String(redactSensitive(chunk.label)), 240)}`
          : input.chunks.length > 1
            ? `${document.title} (${chunk.index + 1}/${input.chunks.length})`
          : document.title,
      content: safeChunkContent,
      tags,
      source,
      tokenEstimate: estimateTokens(safeChunkContent),
      characterCount: safeChunkContent.length,
      embedding:
        safeChunkContent === chunk.content ? chunk.embedding : undefined,
      metadata: {
        ...document.metadata,
        documentTitle: document.title,
        ...(chunk.metadata
          ? redactSensitive(chunk.metadata) as Record<string, unknown>
          : {}),
      },
      createdAt: now,
      updatedAt: now,
    };
  });
  if (canonicalSourceWrite) {
    assertCanonicalKnowledgeLineage(
      safeContent,
      document,
      chunks,
      canonicalSourceWrite,
    );
  }

  if (hasDatabaseUrl()) {
    const lineage = await insertKnowledgeDocumentDb(
      document,
      chunks,
      canonicalSourceWrite,
      input.captureIngestGuard,
    );
    return {
      document: lineage ? document : withoutDocumentLineage(document),
      chunks: lineage ? chunks : chunks.map(withoutChunkLineage),
      lineage,
    };
  }

  let lineage: PersistedKnowledgeLineage | undefined;
  await updateJsonFile<KnowledgeLedger>(
    getKnowledgeFile(),
    { documents: [], chunks: [] },
    (ledger) => {
      const existingDocument = ledger.documents.find(
        (item) => item.id === document.id,
      );
      const inserted = !existingDocument;
      if (
        inserted &&
        chunks.some((chunk) =>
          ledger.chunks.some((existing) => existing.id === chunk.id),
        )
      ) {
        throw new Error(
          "Knowledge chunk ID conflicts with an existing stored chunk.",
        );
      }
      if (inserted && canonicalSourceWrite) {
        ledger.sourceLineage = mergeCanonicalSourceLedger(
          ledger.sourceLineage,
          canonicalSourceWrite,
        );
        lineage = {
          sourceItemId:
            canonicalSourceWrite.adapterOutput.sourceItem.sourceItemId,
          sourceRevisionId:
            canonicalSourceWrite.adapterOutput.sourceRevision.sourceRevisionId,
          evidenceUnitIdsByChunkIndex:
            canonicalSourceWrite.evidenceUnitIdsByChunkIndex,
        };
      } else if (existingDocument) {
        const existingChunks = ledger.chunks
          .filter((chunk) => chunk.documentId === existingDocument.id)
          .sort((left, right) => left.chunkIndex - right.chunkIndex);
        lineage = recoverFileKnowledgeLineage(
          ledger,
          existingDocument,
          existingChunks,
          document,
          chunks,
          canonicalSourceWrite,
        );
      }
      return {
        ...ledger,
        documents: inserted
          ? [document, ...ledger.documents].slice(0, 100)
          : ledger.documents,
        chunks: [
          ...(inserted ? chunks : []).filter(
            (chunk) => !ledger.chunks.some((item) => item.id === chunk.id),
          ),
          ...ledger.chunks,
        ].slice(0, 1200),
      };
    },
  );
  return {
    document: lineage ? document : withoutDocumentLineage(document),
    chunks: lineage ? chunks : chunks.map(withoutChunkLineage),
    lineage,
  };
}

export async function deleteKnowledgeDocumentByIdempotencyKey(idempotencyKey: string, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const documentId = knowledgeDocumentId(tenantId, idempotencyKey);
  const retiredAt = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql().transaction(async (sql: RagSqlClient) => {
      await lockKnowledgeMemoryGraph(sql, tenantId);
      const memoryRows = await sql`
        SELECT id
        FROM omni_memories
        WHERE tenant_id = ${tenantId}
          AND id LIKE ${documentId + "_memory_%"}
          AND claim_status <> 'forgotten'
        ORDER BY id COLLATE "C"
      `;
      const memoryIds = memoryRows.map((row) => String(row.id));
      await invalidateKnowledgeMemoryLineage(sql, tenantId, memoryIds);
      await sql`DELETE FROM omni_knowledge_chunks WHERE tenant_id = ${tenantId} AND document_id = ${documentId}`;
      await sql`DELETE FROM omni_knowledge_documents WHERE tenant_id = ${tenantId} AND id = ${documentId}`;
      await retireKnowledgeMemoryRows(sql, tenantId, memoryIds, retiredAt);
    });
    return documentId;
  }
  await purgeKnowledgeCognitionsForDocuments({
    tenantId,
    documentIds: [documentId],
  });
  await updateJsonFile<KnowledgeLedger>(getKnowledgeFile(), { documents: [], chunks: [] }, (ledger) => ({
    ...ledger,
    documents: ledger.documents.filter((document) => document.id !== documentId || normalizeTenantId(document.tenantId) !== tenantId),
    chunks: ledger.chunks.filter((chunk) => chunk.documentId !== documentId || normalizeTenantId(chunk.tenantId) !== tenantId),
  }));
  await updateJsonFile<MemoryRecord[]>(getDataPath("memory.json"), [], (memories) => memories.map((memory) =>
    normalizeTenantId(memory.tenantId) === tenantId &&
      memory.id.startsWith(`${documentId}_memory_`) &&
      memory.claimStatus !== "forgotten"
      ? { ...memory, title: "[retired]", content: "", tags: [], source: "[retired]", embedding: undefined, evidenceRefs: [], supersedesId: undefined, contradictionOfId: undefined, claimStatus: "superseded", validTo: memory.validTo || retiredAt, forgottenAt: undefined, updatedAt: retiredAt }
      : memory,
  ));
  const { queueMemoryGraphRebuild } = await import("@/lib/memory/graph");
  await queueMemoryGraphRebuild({ tenantId });
  return documentId;
}

export async function deleteKnowledgeDocumentsBySourcePrefix(sourcePrefix: string, options: {
  tenantId?: string;
  actorId?: string;
  mutation?: KnowledgeDeletionMutationContext;
  invalidationScope?: ExecutionScope;
  sql?: RagSqlClient;
} = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const prefix = String(redactSensitive(sourcePrefix)).trim().slice(0, 500);
  if (!prefix) throw new Error("A source prefix is required.");
  const mutation = options.mutation
    ? exactKnowledgeDeletionMutation(
        options.mutation,
        tenantId,
        options.actorId,
        prefix,
      )
    : undefined;
  const retiredAt = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const deleteWithSql = async (sql: RagSqlClient) => {
      await lockKnowledgeMemoryGraph(sql, tenantId);
      const rows = await sql`SELECT id FROM omni_knowledge_documents WHERE tenant_id = ${tenantId} AND source LIKE ${prefix + "%"}`;
      const ids = rows.map((row) => String(row.id));
      const memoryRows = await sql`
        SELECT id
        FROM omni_memories
        WHERE tenant_id = ${tenantId}
          AND source LIKE ${prefix + "%"}
          AND claim_status <> 'forgotten'
        ORDER BY id COLLATE "C"
      `;
      const memoryIds = memoryRows.map((row) => String(row.id));
      const invalidationScope = mutation?.executionScope ||
        options.invalidationScope;
      await invalidateKnowledgeMemoryLineage(sql, tenantId, memoryIds, {
        executionScope: invalidationScope,
        sourceKind: prefix.startsWith("capture:") ? "capture" : "knowledge",
        sourceReference: prefix,
      });
      if (ids.length && invalidationScope) {
        const evidenceRows = await sql`
          SELECT evidence_id AS id, owner_actor_id
          FROM (
            SELECT DISTINCT evidence.id AS evidence_id,
              evidence.owner_actor_id
            FROM omni_knowledge_chunks chunk
            JOIN omni_evidence_units evidence
              ON evidence.tenant_id = chunk.tenant_id
             AND evidence.id = chunk.evidence_unit_id
            WHERE chunk.tenant_id = ${tenantId}
              AND chunk.document_id = ANY(${ids}::TEXT[])
              AND chunk.evidence_unit_id IS NOT NULL
          ) distinct_evidence
          ORDER BY owner_actor_id COLLATE "C", evidence_id COLLATE "C"
        `;
        if (evidenceRows.length) {
          await retireKnowledgeEntityEvidence({
            tenantId,
            evidenceRows,
            executionScope: invalidationScope,
            retiredAt,
            sql,
          });
        }
      }
      if (ids.length) {
        await sql`DELETE FROM omni_knowledge_documents WHERE tenant_id = ${tenantId} AND id = ANY(${ids})`;
      }
      const retired = await retireKnowledgeMemoryRows(
        sql,
        tenantId,
        memoryIds,
        retiredAt,
      );
      if (mutation) {
        await appendKnowledgeDeletionEvent(prefix, mutation, sql);
      }
      return { documents: ids.length, memories: retired.length };
    };
    return options.sql
      ? deleteWithSql(options.sql)
      : getSql().transaction(deleteWithSql);
  }
  const ledger = await readKnowledgeLedger();
  const ids = new Set(ledger.documents.filter((document) => normalizeTenantId(document.tenantId) === tenantId && document.source.startsWith(prefix)).map((document) => document.id));
  const evidenceRows = canonicalFileEvidenceRows(ledger, ids);
  const invalidationScope = mutation?.executionScope || options.invalidationScope;
  if (invalidationScope && evidenceRows.length) {
    await retireKnowledgeEntityEvidence({
      tenantId,
      evidenceRows,
      executionScope: invalidationScope,
      retiredAt,
    });
  }
  await purgeKnowledgeCognitionsForDocuments({
    tenantId,
    documentIds: [...ids],
  });
  await updateJsonFile<KnowledgeLedger>(getKnowledgeFile(), { documents: [], chunks: [] }, (current) => ({
    ...current,
    documents: current.documents.filter((document) => !ids.has(document.id)),
    chunks: current.chunks.filter((chunk) => !ids.has(chunk.documentId)),
  }));
  let memories = 0;
  await updateJsonFile<MemoryRecord[]>(getDataPath("memory.json"), [], (items) => items.map((memory) => {
    if (
      normalizeTenantId(memory.tenantId) !== tenantId ||
      !memory.source.startsWith(prefix) ||
      memory.claimStatus === "forgotten"
    ) return memory;
    memories += 1;
    return { ...memory, title: "[retired]", content: "", tags: [], source: "[retired]", embedding: undefined, evidenceRefs: [], supersedesId: undefined, contradictionOfId: undefined, claimStatus: "superseded", validTo: memory.validTo || retiredAt, forgottenAt: undefined, updatedAt: retiredAt };
  }));
  const { queueMemoryGraphRebuild } = await import("@/lib/memory/graph");
  await queueMemoryGraphRebuild({ tenantId });
  if (mutation) {
    await appendKnowledgeDeletionEvent(prefix, mutation);
  }
  return { documents: ids.size, memories };
}

export async function retireSupersededCaptureKnowledge(input: {
  captureIngestGuard: CaptureIngestGuard;
  executionScope: ExecutionScope;
  keepDocumentId: string;
}): Promise<{ documents: number; memories: number }> {
  const guard = input.captureIngestGuard;
  const tenantId = normalizeTenantId(guard.tenantId);
  const source = captureIngestSource(guard);
  const keepDocumentId = input.keepDocumentId.trim();
  const scope = parsePersistedExecutionScope(input.executionScope);
  const exactOwnerUser =
    scope?.executingPrincipalType === "user" &&
    scope.executingPrincipalId === guard.actorId;
  const governedSystem =
    scope?.executingPrincipalType === "system" &&
    Boolean(scope.executingPrincipalId);
  assertCaptureIngestSource(guard, tenantId, source);
  if (
    !keepDocumentId ||
    !scope ||
    scope.tenantId !== tenantId ||
    scope.initiatingActorId !== guard.actorId ||
    (!exactOwnerUser && !governedSystem)
  ) {
    throw new Error(
      "Capture knowledge supersession requires an exact actor-bound execution scope.",
    );
  }
  const retiredAt = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(tenantId, [guard.actorId], () =>
      getSql().transaction(async (sql: RagSqlClient) => {
        await lockActiveCaptureIngest(sql, guard);
        await lockKnowledgeMemoryGraph(sql, tenantId);
        const currentRows = await sql`
          SELECT document.source_item_id, source_item.current_revision_id
          FROM omni_knowledge_documents document
          JOIN omni_source_items source_item
            ON source_item.tenant_id = document.tenant_id
           AND source_item.id = document.source_item_id
          WHERE document.tenant_id = ${tenantId}
            AND document.id = ${keepDocumentId}
            AND document.source = ${source}
            AND document.source_revision_id = source_item.current_revision_id
            AND source_item.owner_actor_id = ${guard.actorId}
            AND source_item.connection_id = 'first_party.capture'
            AND source_item.adapter_id = 'asael.capture'
          FOR UPDATE OF document, source_item
        `;
        if (currentRows.length !== 1) {
          throw new Error(
            "Current Capture knowledge document is unavailable in its source scope.",
          );
        }
        const sourceItemId = String(currentRows[0].source_item_id);
        const currentRevisionId = String(
          currentRows[0].current_revision_id,
        );
        const documentRows = await sql`
          SELECT id
          FROM omni_knowledge_documents
          WHERE tenant_id = ${tenantId}
            AND source_item_id = ${sourceItemId}
            AND id <> ${keepDocumentId}
            AND source_revision_id <> ${currentRevisionId}
          ORDER BY id COLLATE "C"
          FOR UPDATE
        `;
        const documentIds = documentRows.map((row) => String(row.id));
        if (!documentIds.length) return { documents: 0, memories: 0 };

        const knowledgeRefs = documentIds.map((id) => `knowledge:${id}`);
        const memoryRows = await sql`
          SELECT memory.id
          FROM omni_memories memory
          WHERE memory.tenant_id = ${tenantId}
            AND (
              memory.evidence_refs && ${knowledgeRefs}::text[]
              OR EXISTS (
                SELECT 1
                FROM unnest(${documentIds}::text[]) document_id
                WHERE starts_with(
                  memory.id,
                  document_id || '_memory_'
                )
              )
            )
            AND memory.claim_status <> 'forgotten'
          ORDER BY memory.id COLLATE "C"
        `;
        const memoryIds = memoryRows.map((row) => String(row.id));
        await invalidateKnowledgeMemoryLineage(sql, tenantId, memoryIds, {
          executionScope: input.executionScope,
          sourceKind: "capture",
          sourceReference: source,
        });

        const evidenceRows = await sql`
          SELECT evidence_id AS id, owner_actor_id
          FROM (
            SELECT DISTINCT evidence.id AS evidence_id,
              evidence.owner_actor_id
            FROM omni_knowledge_chunks chunk
            JOIN omni_evidence_units evidence
              ON evidence.tenant_id = chunk.tenant_id
             AND evidence.id = chunk.evidence_unit_id
            WHERE chunk.tenant_id = ${tenantId}
              AND chunk.document_id = ANY(${documentIds}::text[])
              AND chunk.evidence_unit_id IS NOT NULL
          ) distinct_evidence
          ORDER BY owner_actor_id COLLATE "C", evidence_id COLLATE "C"
        `;
        if (evidenceRows.length) {
          await retireKnowledgeEntityEvidence({
            tenantId,
            evidenceRows,
            executionScope: input.executionScope,
            retiredAt,
            sql,
          });
        }

        await sql`
          DELETE FROM omni_knowledge_chunks
          WHERE tenant_id = ${tenantId}
            AND document_id = ANY(${documentIds}::text[])
        `;
        await sql`
          DELETE FROM omni_knowledge_documents
          WHERE tenant_id = ${tenantId}
            AND id = ANY(${documentIds}::text[])
        `;
        const retired = await retireKnowledgeMemoryRows(
          sql,
          tenantId,
          memoryIds,
          retiredAt,
        );
        await appendCaptureKnowledgeSupersessionEvent({
          tenantId,
          sourceItemId,
          keepDocumentId,
          retiredDocumentCount: documentIds.length,
          retiredMemoryCount: retired.length,
          retiredAt,
          executionScope: input.executionScope,
          sql,
        });
        return { documents: documentIds.length, memories: retired.length };
      }) as Promise<{ documents: number; memories: number }>
    );
  }

  const ledger = await readKnowledgeLedger();
  const current = ledger.documents.find((document) =>
    normalizeTenantId(document.tenantId) === tenantId &&
    document.id === keepDocumentId &&
    document.source === source
  );
  if (!current) {
    throw new Error(
      "Current Capture knowledge document is unavailable in its source scope.",
    );
  }
  const currentOutput = ledger.sourceLineage?.adapterOutputs
    .map((candidate) => sourceAdapterUpsertV1Schema.parse(candidate))
    .find((output) =>
      output.sourceItem.sourceItemId === current.sourceItemId
    );
  if (
    !current.sourceItemId ||
    !current.sourceRevisionId ||
    !currentOutput ||
    currentOutput.sourceRevision.sourceRevisionId !==
      current.sourceRevisionId ||
    currentOutput.sourceItem.ownerActorId !== guard.actorId ||
    currentOutput.sourceItem.connectionId !== "first_party.capture" ||
    currentOutput.adapterId !== "asael.capture"
  ) {
    throw new Error(
      "Current Capture knowledge document is not the canonical source revision.",
    );
  }
  const sourceItemId = current.sourceItemId;
  const documentIds = new Set(ledger.documents
    .filter((document) =>
      normalizeTenantId(document.tenantId) === tenantId &&
      document.sourceItemId === sourceItemId &&
      document.sourceRevisionId !== current.sourceRevisionId &&
      document.id !== keepDocumentId
    )
    .map((document) => document.id));
  if (!documentIds.size) return { documents: 0, memories: 0 };

  const evidenceRows = canonicalFileEvidenceRows(ledger, documentIds);
  if (exactOwnerUser && evidenceRows.length) {
    await retireKnowledgeEntityEvidence({
      tenantId,
      evidenceRows,
      executionScope: input.executionScope,
      retiredAt,
    });
  }
  await purgeKnowledgeCognitionsForDocuments({
    tenantId,
    documentIds: [...documentIds],
  });
  await updateJsonFile<KnowledgeLedger>(
    getKnowledgeFile(),
    { documents: [], chunks: [] },
    (currentLedger) => ({
      ...currentLedger,
      documents: currentLedger.documents.filter((document) =>
        !documentIds.has(document.id)
      ),
      chunks: currentLedger.chunks.filter((chunk) =>
        !documentIds.has(chunk.documentId)
      ),
    }),
  );
  let memories = 0;
  await updateJsonFile<MemoryRecord[]>(
    getDataPath("memory.json"),
    [],
    (items) => items.map((memory) => {
      if (
        normalizeTenantId(memory.tenantId) !== tenantId ||
        memory.claimStatus === "forgotten" ||
        !(
          [...documentIds].some((documentId) =>
            memory.id.startsWith(`${documentId}_memory_`)
          ) ||
          memory.evidenceRefs?.some((reference) =>
            reference.startsWith("knowledge:") &&
            documentIds.has(reference.slice("knowledge:".length))
          )
        )
      ) return memory;
      memories += 1;
      return {
        ...memory,
        title: "[retired]",
        content: "",
        tags: [],
        source: "[retired]",
        embedding: undefined,
        evidenceRefs: [],
        supersedesId: undefined,
        contradictionOfId: undefined,
        claimStatus: "superseded" as const,
        validTo: memory.validTo || retiredAt,
        forgottenAt: undefined,
        updatedAt: retiredAt,
      };
    }),
  );
  const { queueMemoryGraphRebuild } = await import("@/lib/memory/graph");
  await queueMemoryGraphRebuild({ tenantId });
  await appendCaptureKnowledgeSupersessionEvent({
    tenantId,
    sourceItemId,
    keepDocumentId,
    retiredDocumentCount: documentIds.size,
    retiredMemoryCount: memories,
    retiredAt,
    executionScope: input.executionScope,
  });
  return { documents: documentIds.size, memories };
}

async function appendCaptureKnowledgeSupersessionEvent(input: {
  tenantId: string;
  sourceItemId: string;
  keepDocumentId: string;
  retiredDocumentCount: number;
  retiredMemoryCount: number;
  retiredAt: string;
  executionScope: ExecutionScope;
  sql?: RagSqlClient;
}) {
  await appendScopedDomainEvent(
    buildCaptureKnowledgeSupersessionEvent(input),
    input.sql ? { sql: input.sql } : {},
  );
}

async function retireKnowledgeEntityEvidence(input: {
  tenantId: string;
  evidenceRows: readonly Readonly<Record<string, unknown>>[];
  executionScope: ExecutionScope;
  retiredAt: string;
  sql?: RagSqlClient;
}) {
  const scope = parsePersistedExecutionScope(input.executionScope);
  if (!scope?.initiatingActorId || scope.tenantId !== input.tenantId) {
    throw new Error(
      "Knowledge evidence retirement requires an actor-bound execution scope.",
    );
  }
  const ownerIds = new Set(input.evidenceRows.map((row) =>
    String(row.owner_actor_id)
  ));
  if (ownerIds.size !== 1 || !ownerIds.has(scope.initiatingActorId)) {
    throw new Error(
      "Knowledge evidence retirement cannot cross actor ownership.",
    );
  }
  await retireEntityEvidenceLineage({
    tenantId: input.tenantId,
    ownerActorId: scope.initiatingActorId,
    evidenceUnitIds: input.evidenceRows.map((row) => String(row.id)),
    executionScope: deriveExecutionScope(scope, {
      purpose: "entity.source.lifecycle.v1",
    }),
    retiredAt: input.retiredAt,
    sql: input.sql,
  });
  await queueTemporalRelationProjection({
    tenantId: input.tenantId,
    ownerActorId: scope.initiatingActorId,
    executionScope: input.executionScope,
    sql: input.sql,
  });
}

function canonicalFileEvidenceRows(
  ledger: KnowledgeLedger,
  documentIds: ReadonlySet<string>,
) {
  const evidenceIds = new Set(ledger.chunks
    .filter((chunk) => documentIds.has(chunk.documentId))
    .map((chunk) => chunk.evidenceUnitId)
    .filter((id): id is string => Boolean(id)));
  if (!evidenceIds.size) return [];
  const rows: Array<{ id: string; owner_actor_id: string }> = [];
  for (const outputValue of ledger.sourceLineage?.adapterOutputs || []) {
    const output = sourceAdapterUpsertV1Schema.parse(outputValue);
    for (const evidence of output.evidenceUnits) {
      if (!evidenceIds.has(evidence.evidenceUnitId)) continue;
      rows.push({
        id: evidence.evidenceUnitId,
        owner_actor_id: evidence.ownerActorId,
      });
    }
  }
  return rows.sort((left, right) =>
    left.owner_actor_id.localeCompare(right.owner_actor_id) ||
    left.id.localeCompare(right.id)
  );
}

function exactKnowledgeDeletionMutation(
  value: KnowledgeDeletionMutationContext,
  tenantId: string,
  actorId: string | undefined,
  sourcePrefix: string,
) {
  const executionScope = parsePersistedExecutionScope(value.executionScope);
  if (!executionScope || !actorId) {
    throw new Error("Knowledge deletion requires an authenticated execution scope.");
  }
  assertExecutionScopeTenant(executionScope, tenantId);
  if (
    executionScope.initiatingActorId !== actorId ||
    executionScope.executingPrincipalType !== "user" ||
    executionScope.executingPrincipalId !== actorId ||
    executionScope.causationId !== knowledgeDeletionTargetId(sourcePrefix) ||
    executionScope.purpose !== "knowledge.delete_source"
  ) {
    throw new Error(
      "Knowledge deletion scope must bind the authenticated user and source target.",
    );
  }
  const idempotencyKey = value.idempotencyKey.trim();
  if (
    !idempotencyKey ||
    idempotencyKey.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
  ) {
    throw new Error(
      "Knowledge deletion Idempotency-Key must use 1-200 letters, numbers, dots, underscores, colons, or hyphens.",
    );
  }
  return { executionScope, idempotencyKey } as const;
}

async function appendKnowledgeDeletionEvent(
  sourcePrefix: string,
  mutation: ReturnType<typeof exactKnowledgeDeletionMutation>,
  sql?: RagSqlClient,
) {
  const { executionScope, idempotencyKey } = mutation;
  const actorId = executionScope.initiatingActorId;
  if (!actorId) throw new Error("Knowledge deletion event is missing its actor.");
  const payload = knowledgeDeletionEventPayloadSchema.parse({
    schemaVersion: KNOWLEDGE_DELETION_EVENT_SCHEMA_VERSION,
    operation: "delete_source_prefix",
    sourcePrefixSha256: knowledgeDeletionSha256(sourcePrefix),
    idempotencyKeySha256: knowledgeDeletionSha256({
      tenantId: executionScope.tenantId,
      actorId,
      idempotencyKey,
    }),
  });
  await appendScopedDomainEvent({
    id: knowledgeDeletionEventId({
      tenantId: executionScope.tenantId,
      actorId,
      idempotencyKey,
    }),
    streamId: knowledgeDeletionTargetId(sourcePrefix),
    type: "knowledge.source_deleted",
    executionScope,
    payload,
  }, sql ? { sql } : {});
}

async function lockKnowledgeMemoryGraph(sql: RagSqlClient, tenantId: string) {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`memory-graph:${tenantId}`}, 0)
    )
  `;
}

async function invalidateKnowledgeMemoryLineage(
  sql: RagSqlClient,
  tenantId: string,
  memoryIds: string[],
  invalidation?: {
    executionScope?: ExecutionScope;
    sourceKind: "knowledge" | "capture";
    sourceReference: string;
  },
) {
  if (!memoryIds.length) return;
  const traceRows = await sql`
    SELECT id
    FROM omni_retrieval_traces
    WHERE tenant_id = ${tenantId}
      AND memory_ids && ${memoryIds}::text[]
    ORDER BY id COLLATE "C"
    FOR UPDATE
  `;
  if (invalidation?.executionScope) {
    await invalidateRunsForDeletedContext({
      tenantId,
      retrievalTraceIds: traceRows.map((row) => String(row.id)),
      executionScope: invalidation.executionScope,
      sourceKind: invalidation.sourceKind,
      sourceReference: invalidation.sourceReference,
      sql,
    });
  }
  await sql`
    DELETE FROM omni_memory_graph_edges edge
    WHERE edge.tenant_id = ${tenantId}
      AND (
        edge.memory_ids && ${memoryIds}::text[]
        OR EXISTS (
          SELECT 1
          FROM omni_memory_graph_nodes endpoint
          WHERE endpoint.tenant_id = edge.tenant_id
            AND endpoint.id IN (edge.source_node_id, edge.target_node_id)
            AND endpoint.memory_ids && ${memoryIds}::text[]
        )
      )
  `;
  await sql`
    DELETE FROM omni_memory_graph_nodes
    WHERE tenant_id = ${tenantId}
      AND memory_ids && ${memoryIds}::text[]
  `;
  await sql`
    DELETE FROM omni_retrieval_traces
    WHERE tenant_id = ${tenantId}
      AND memory_ids && ${memoryIds}::text[]
  `;
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
}

async function retireKnowledgeMemoryRows(
  sql: RagSqlClient,
  tenantId: string,
  memoryIds: string[],
  retiredAt: string,
) {
  if (!memoryIds.length) return [];
  const vectorColumnRows = await sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'omni_memories'
      AND column_name = 'embedding_vector'
    LIMIT 1
  `;
  return vectorColumnRows[0]
    ? sql`
        UPDATE omni_memories
        SET title = '[retired]',
            content = '',
            tags = '{}'::text[],
            source = '[retired]',
            embedding = NULL,
            embedding_vector = NULL,
            evidence_refs = '{}'::text[],
            supersedes_id = NULL,
            contradiction_of_id = NULL,
            claim_status = 'superseded',
            valid_to = COALESCE(valid_to, ${retiredAt}),
            forgotten_at = NULL,
            updated_at = ${retiredAt}
        WHERE tenant_id = ${tenantId}
          AND id = ANY(${memoryIds}::text[])
          AND claim_status <> 'forgotten'
          AND NOT omni_memory_ids_have_deletion_barrier(
            tenant_id,
            ARRAY[id]
          )
        RETURNING id
      `
    : sql`
        UPDATE omni_memories
        SET title = '[retired]',
            content = '',
            tags = '{}'::text[],
            source = '[retired]',
            embedding = NULL,
            evidence_refs = '{}'::text[],
            supersedes_id = NULL,
            contradiction_of_id = NULL,
            claim_status = 'superseded',
            valid_to = COALESCE(valid_to, ${retiredAt}),
            forgotten_at = NULL,
            updated_at = ${retiredAt}
        WHERE tenant_id = ${tenantId}
          AND id = ANY(${memoryIds}::text[])
          AND claim_status <> 'forgotten'
          AND NOT omni_memory_ids_have_deletion_barrier(
            tenant_id,
            ARRAY[id]
          )
        RETURNING id
      `;
}

export function knowledgeDocumentId(tenantId: string, idempotencyKey: string) {
  return `knowledge_${createHash("sha256").update(`${normalizeTenantId(tenantId)}:${idempotencyKey}`).digest("hex").slice(0, 40)}`;
}

export async function listKnowledgeDocuments(limit = 20, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_knowledge_documents
      WHERE tenant_id = ${tenantId}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(documentFromRow);
  }

  const ledger = await readKnowledgeLedger();
  return ledger.documents
    .filter((document) => normalizeTenantId(document.tenantId) === tenantId)
    .slice(0, limit)
    .map(sanitizeKnowledgeDocument);
}

export async function listKnowledgeChunks(limit = 20, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_knowledge_chunks
      WHERE tenant_id = ${tenantId}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(chunkFromRow);
  }

  const ledger = await readKnowledgeLedger();
  return ledger.chunks
    .filter((chunk) => normalizeTenantId(chunk.tenantId) === tenantId)
    .slice(0, limit)
    .map(sanitizeKnowledgeChunk);
}

export type ActorOwnedCognitionSource = Readonly<{
  document: KnowledgeDocument;
  chunks: readonly KnowledgeChunk[];
  sourceItemId: string;
  sourceRevisionId: string;
}>;

/**
 * Returns one complete, current, actor-owned evidence set that explicitly
 * permits the cognition purpose. Partial, superseded, legacy, and cross-owner
 * documents fail closed instead of being sent to a model.
 */
export async function getActorOwnedKnowledgeForCognition(input: {
  tenantId: string;
  actorId: string;
  documentId: string;
}): Promise<ActorOwnedCognitionSource | null> {
  const tenantId = normalizeTenantId(input.tenantId);
  const actorId = cognitionContractId(input.actorId, "actor");
  const documentId = cognitionContractId(input.documentId, "document");
  const asOfTime = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT document.*,
        jsonb_agg(
          jsonb_build_object(
            'chunk', to_jsonb(chunk),
            'evidence', to_jsonb(evidence)
          )
          ORDER BY chunk.chunk_index, chunk.id COLLATE "C"
        ) AS cognition_lineage_rows
      FROM omni_knowledge_documents document
      JOIN omni_source_items item
        ON item.tenant_id = document.tenant_id
       AND item.id = document.source_item_id
       AND item.current_revision_id = document.source_revision_id
       AND item.adapter_operation = 'upsert'
      JOIN omni_source_revisions revision
        ON revision.tenant_id = document.tenant_id
       AND revision.id = document.source_revision_id
       AND revision.source_item_id = item.id
       AND revision.adapter_operation = 'upsert'
      JOIN omni_knowledge_chunks chunk
        ON chunk.tenant_id = document.tenant_id
       AND chunk.document_id = document.id
      LEFT JOIN omni_evidence_units evidence
        ON evidence.tenant_id = chunk.tenant_id
       AND evidence.id = chunk.evidence_unit_id
      WHERE document.tenant_id = ${tenantId}
        AND document.id = ${documentId}
        AND item.owner_actor_id = ${actorId}
        AND revision.owner_actor_id = ${actorId}
        AND item.visibility = 'user_private'
        AND revision.visibility = 'user_private'
        AND ${KNOWLEDGE_COGNIFY_PURPOSE_ID} = ANY(item.allowed_purpose_ids)
        AND ${KNOWLEDGE_COGNIFY_PURPOSE_ID} = ANY(revision.allowed_purpose_ids)
        AND (item.retention_expires_at IS NULL OR item.retention_expires_at > ${asOfTime})
        AND (revision.retention_expires_at IS NULL OR revision.retention_expires_at > ${asOfTime})
        AND item.captured_at <= ${asOfTime}
        AND revision.captured_at <= ${asOfTime}
      GROUP BY document.id
      HAVING COUNT(*) = document.chunk_count
        AND COUNT(DISTINCT chunk.id) = document.chunk_count
        AND COUNT(DISTINCT evidence.id) = document.chunk_count
        AND (
          SELECT COUNT(*)
          FROM omni_evidence_units revision_evidence
          WHERE revision_evidence.tenant_id = document.tenant_id
            AND revision_evidence.source_item_id = document.source_item_id
            AND revision_evidence.source_revision_id = document.source_revision_id
        ) = document.chunk_count
        AND BOOL_AND(
          evidence.id IS NOT NULL
          AND chunk.source_revision_id = document.source_revision_id
          AND evidence.source_item_id = document.source_item_id
          AND evidence.source_revision_id = document.source_revision_id
          AND evidence.owner_actor_id = ${actorId}
          AND evidence.visibility = 'user_private'
          AND evidence.adapter_operation = 'upsert'
          AND ${KNOWLEDGE_COGNIFY_PURPOSE_ID} = ANY(evidence.allowed_purpose_ids)
          AND (
            evidence.retention_expires_at IS NULL
            OR evidence.retention_expires_at > ${asOfTime}
          )
          AND evidence.captured_at <= ${asOfTime}
          AND evidence.extracted_at <= ${asOfTime}
        )
      LIMIT 1
    `;
    if (!rows[0]) return null;
    const document = documentFromRow(rows[0]);
    if (!document.sourceItemId || !document.sourceRevisionId) return null;
    const chunks = cognitionDatabaseChunks(
      rows[0].cognition_lineage_rows,
      document,
      { tenantId, actorId, asOfTime },
    );
    if (
      chunks.length !== document.chunkCount ||
      chunks.some((chunk, index) =>
        chunk.chunkIndex !== index ||
        !chunk.evidenceUnitId ||
        chunk.sourceRevisionId !== document.sourceRevisionId
      )
    ) return null;
    return Object.freeze({
      document,
      chunks: Object.freeze(chunks),
      sourceItemId: document.sourceItemId,
      sourceRevisionId: document.sourceRevisionId,
    });
  }

  const ledger = await readKnowledgeLedger();
  const document = ledger.documents.find((candidate) =>
    normalizeTenantId(candidate.tenantId) === tenantId &&
    candidate.id === documentId
  );
  if (!document?.sourceItemId || !document.sourceRevisionId) return null;
  const outputs = currentCognitionOutputs(ledger);
  if (!outputs) return null;
  const output = outputs.find((candidate) =>
    candidate.tenantId === tenantId &&
    candidate.sourceItem.sourceItemId === document.sourceItemId
  );
  if (
    !output ||
    output.sourceRevision.sourceRevisionId !== document.sourceRevisionId ||
    !cognitionOutputIsEligible(output, { tenantId, actorId, asOfTime })
  ) return null;
  const chunks = cognitionFileChunks({
    ledger,
    document,
    output,
    tenantId,
    actorId,
    asOfTime,
  });
  if (!chunks) return null;
  return Object.freeze({
    document: sanitizeKnowledgeDocument(document),
    chunks: Object.freeze(chunks),
    sourceItemId: document.sourceItemId,
    sourceRevisionId: document.sourceRevisionId,
  });
}

/** Lists current documents eligible for an explicit cognition request. */
export async function listActorOwnedKnowledgeDocumentsForCognition(input: {
  tenantId: string;
  actorId: string;
  limit?: number;
}) {
  const tenantId = normalizeTenantId(input.tenantId);
  const actorId = cognitionContractId(input.actorId, "actor");
  const limit = Math.min(Math.max(Math.round(input.limit || 24), 1), 100);
  const asOfTime = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT document.*,
        jsonb_agg(
          jsonb_build_object(
            'chunk', to_jsonb(chunk),
            'evidence', to_jsonb(evidence)
          )
          ORDER BY chunk.chunk_index, chunk.id COLLATE "C"
        ) AS cognition_lineage_rows
      FROM omni_knowledge_documents document
      JOIN omni_source_items item
        ON item.tenant_id = document.tenant_id
       AND item.id = document.source_item_id
       AND item.current_revision_id = document.source_revision_id
       AND item.adapter_operation = 'upsert'
      JOIN omni_source_revisions revision
        ON revision.tenant_id = document.tenant_id
       AND revision.id = document.source_revision_id
       AND revision.source_item_id = item.id
       AND revision.adapter_operation = 'upsert'
      JOIN omni_knowledge_chunks chunk
        ON chunk.tenant_id = document.tenant_id
       AND chunk.document_id = document.id
      LEFT JOIN omni_evidence_units evidence
        ON evidence.tenant_id = chunk.tenant_id
       AND evidence.id = chunk.evidence_unit_id
      WHERE document.tenant_id = ${tenantId}
        AND item.owner_actor_id = ${actorId}
        AND revision.owner_actor_id = ${actorId}
        AND item.visibility = 'user_private'
        AND revision.visibility = 'user_private'
        AND ${KNOWLEDGE_COGNIFY_PURPOSE_ID} = ANY(item.allowed_purpose_ids)
        AND ${KNOWLEDGE_COGNIFY_PURPOSE_ID} = ANY(revision.allowed_purpose_ids)
        AND (item.retention_expires_at IS NULL OR item.retention_expires_at > ${asOfTime})
        AND (revision.retention_expires_at IS NULL OR revision.retention_expires_at > ${asOfTime})
        AND item.captured_at <= ${asOfTime}
        AND revision.captured_at <= ${asOfTime}
      GROUP BY document.id
      HAVING COUNT(*) = document.chunk_count
        AND COUNT(DISTINCT chunk.id) = document.chunk_count
        AND COUNT(DISTINCT evidence.id) = document.chunk_count
        AND (
          SELECT COUNT(*)
          FROM omni_evidence_units revision_evidence
          WHERE revision_evidence.tenant_id = document.tenant_id
            AND revision_evidence.source_item_id = document.source_item_id
            AND revision_evidence.source_revision_id = document.source_revision_id
        ) = document.chunk_count
        AND BOOL_AND(
          evidence.id IS NOT NULL
          AND chunk.source_revision_id = document.source_revision_id
          AND evidence.source_item_id = document.source_item_id
          AND evidence.source_revision_id = document.source_revision_id
          AND evidence.owner_actor_id = ${actorId}
          AND evidence.visibility = 'user_private'
          AND evidence.adapter_operation = 'upsert'
          AND ${KNOWLEDGE_COGNIFY_PURPOSE_ID} = ANY(evidence.allowed_purpose_ids)
          AND (
            evidence.retention_expires_at IS NULL
            OR evidence.retention_expires_at > ${asOfTime}
          )
          AND evidence.captured_at <= ${asOfTime}
          AND evidence.extracted_at <= ${asOfTime}
        )
      ORDER BY document.updated_at DESC, document.id COLLATE "C"
      LIMIT ${limit}
    `;
    return rows.flatMap((row) => {
      const document = documentFromRow(row);
      if (!document.sourceItemId || !document.sourceRevisionId) return [];
      const chunks = cognitionDatabaseChunks(
        row.cognition_lineage_rows,
        document,
        { tenantId, actorId, asOfTime },
      );
      return chunks.length === document.chunkCount
        ? [document]
        : [];
    });
  }
  const ledger = await readKnowledgeLedger();
  const outputs = currentCognitionOutputs(ledger);
  if (!outputs) return [];
  const eligibleByRevisionId = new Map(outputs
    .filter((output) =>
      cognitionOutputIsEligible(output, { tenantId, actorId, asOfTime })
    )
    .map((output) => [output.sourceRevision.sourceRevisionId, output] as const));
  return ledger.documents
    .filter((document) =>
      normalizeTenantId(document.tenantId) === tenantId &&
      Boolean(document.sourceRevisionId) &&
      Boolean(document.sourceItemId) &&
      eligibleByRevisionId.get(document.sourceRevisionId!)?.sourceItem
        .sourceItemId === document.sourceItemId &&
      Boolean(cognitionFileChunks({
        ledger,
        document,
        output: eligibleByRevisionId.get(document.sourceRevisionId!)!,
        tenantId,
        actorId,
        asOfTime,
      })),
    )
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id)
    )
    .slice(0, limit)
    .map(sanitizeKnowledgeDocument);
}

/**
 * P2.8 export boundary. Only canonical knowledge attributed to the exact
 * owner is portable; legacy tenant-wide rows are disclosed as excluded rather
 * than silently assigned to the requesting user.
 */
export async function listActorOwnedKnowledgeForPortableArchive(options: {
  tenantId: string;
  actorId: string;
  documentLimit?: number;
  chunkLimit?: number;
}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = String(options.actorId).trim().slice(0, 320);
  const documentLimit = Math.min(Math.max(options.documentLimit || 5_000, 1), 5_000);
  const chunkLimit = Math.min(Math.max(options.chunkLimit || 50_000, 1), 50_000);
  if (!actorId) throw new Error("Portable knowledge export requires an exact actor.");

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT document.*, COUNT(*) OVER()::int AS portable_total_count
      FROM omni_knowledge_documents AS document
      INNER JOIN omni_source_items AS source_item
        ON source_item.tenant_id = document.tenant_id
        AND source_item.id = document.source_item_id
        AND source_item.current_revision_id = document.source_revision_id
        AND source_item.adapter_operation = 'upsert'
      WHERE document.tenant_id = ${tenantId}
        AND source_item.owner_actor_id = ${actorId}
      ORDER BY document.updated_at DESC, document.id COLLATE "C" ASC
      LIMIT ${documentLimit}
    `;
    const totalDocumentCount = Number(rows[0]?.portable_total_count || 0);
    const selectedRows: Record<string, unknown>[] = [];
    let selectedChunkCount = 0;
    for (const row of rows) {
      const chunkCount = Math.max(0, Number(row.chunk_count || 0));
      if (selectedChunkCount + chunkCount > chunkLimit) break;
      selectedRows.push(row);
      selectedChunkCount += chunkCount;
    }
    const documents = selectedRows.map(documentFromRow);
    const documentIds = documents.map((document) => document.id);
    const chunkRows = documentIds.length
      ? await getSql()`
          SELECT chunk.*
          FROM omni_knowledge_chunks AS chunk
          INNER JOIN omni_evidence_units AS evidence
            ON evidence.tenant_id = chunk.tenant_id
            AND evidence.id = chunk.evidence_unit_id
            AND evidence.source_revision_id = chunk.source_revision_id
          WHERE chunk.tenant_id = ${tenantId}
            AND chunk.document_id = ANY(${documentIds}::text[])
            AND evidence.owner_actor_id = ${actorId}
          ORDER BY chunk.document_id COLLATE "C" ASC, chunk.chunk_index ASC,
            chunk.id COLLATE "C" ASC
          LIMIT ${chunkLimit}
        `
      : [];
    const chunks = chunkRows.map(chunkFromRow);
    const chunkCountsByDocument = countChunksByDocument(chunks);
    const exactDocumentIds = new Set(documents
      .filter((document) => chunkCountsByDocument.get(document.id) === document.chunkCount)
      .map((document) => document.id));
    return {
      documents: documents.filter((document) => exactDocumentIds.has(document.id)),
      chunks: chunks.filter((chunk) => exactDocumentIds.has(chunk.documentId)),
      totalDocumentCount,
      excludedDocumentCount: totalDocumentCount - exactDocumentIds.size,
    };
  }

  const ledger = await readKnowledgeLedger();
  const currentOwnedRevisionIds = new Set<string>();
  const settledSourceItemIds = new Set<string>();
  for (const candidate of ledger.sourceLineage?.adapterOutputs || []) {
    const output = sourceAdapterUpsertV1Schema.parse(candidate);
    if (settledSourceItemIds.has(output.sourceItem.sourceItemId)) continue;
    settledSourceItemIds.add(output.sourceItem.sourceItemId);
    if (
      output.tenantId === tenantId &&
      output.sourceItem.ownerActorId === actorId &&
      output.operation === "upsert"
    ) {
      currentOwnedRevisionIds.add(output.sourceRevision.sourceRevisionId);
    }
  }
  const ownedDocuments = ledger.documents
    .filter((document) =>
      normalizeTenantId(document.tenantId) === tenantId &&
      Boolean(document.sourceRevisionId) &&
      currentOwnedRevisionIds.has(document.sourceRevisionId!),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  const selectedDocuments = [] as KnowledgeDocument[];
  let selectedChunkCount = 0;
  for (const document of ownedDocuments.slice(0, documentLimit)) {
    if (selectedChunkCount + document.chunkCount > chunkLimit) break;
    selectedDocuments.push(sanitizeKnowledgeDocument(document));
    selectedChunkCount += document.chunkCount;
  }
  const selectedIds = new Set(selectedDocuments.map((document) => document.id));
  const chunks = ledger.chunks
    .filter((chunk) => normalizeTenantId(chunk.tenantId) === tenantId && selectedIds.has(chunk.documentId))
    .sort((left, right) => left.documentId.localeCompare(right.documentId) || left.chunkIndex - right.chunkIndex)
    .map(sanitizeKnowledgeChunk);
  const chunkCountsByDocument = countChunksByDocument(chunks);
  const exactDocumentIds = new Set(selectedDocuments
    .filter((document) => chunkCountsByDocument.get(document.id) === document.chunkCount)
    .map((document) => document.id));
  return {
    documents: selectedDocuments.filter((document) => exactDocumentIds.has(document.id)),
    chunks: chunks.filter((chunk) => exactDocumentIds.has(chunk.documentId)),
    totalDocumentCount: ownedDocuments.length,
    excludedDocumentCount: ownedDocuments.length - exactDocumentIds.size,
  };
}

function countChunksByDocument(chunks: KnowledgeChunk[]) {
  const counts = new Map<string, number>();
  for (const chunk of chunks) {
    counts.set(chunk.documentId, (counts.get(chunk.documentId) || 0) + 1);
  }
  return counts;
}

/**
 * Resolves only tenant-scoped knowledge chunks that retain an exact immutable
 * EvidenceUnitV1 binding. Missing or legacy chunks are deliberately omitted.
 */
export async function getCanonicalKnowledgeEvidenceByChunkIds(
  chunkIds: readonly string[],
  options: { tenantId?: string } = {},
): Promise<CanonicalKnowledgeEvidence[]> {
  const tenantId = normalizeTenantId(options.tenantId);
  const ids = [...new Set(
    chunkIds
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  )].slice(0, 128);
  if (!ids.length) return [];

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT
        chunk.*,
        to_jsonb(evidence) AS canonical_evidence,
        source_item.current_revision_id AS canonical_current_revision_id,
        source_item.adapter_operation AS canonical_adapter_operation
      FROM omni_knowledge_chunks AS chunk
      INNER JOIN omni_evidence_units AS evidence
        ON evidence.tenant_id = chunk.tenant_id
       AND evidence.id = chunk.evidence_unit_id
       AND evidence.source_revision_id = chunk.source_revision_id
      INNER JOIN omni_source_items AS source_item
        ON source_item.tenant_id = evidence.tenant_id
       AND source_item.id = evidence.source_item_id
      WHERE chunk.tenant_id = ${tenantId}
        AND chunk.id = ANY(${ids})
    `;
    return orderCanonicalKnowledgeEvidence(
      rows.map((row) => ({
        chunk: chunkFromRow(row),
        evidenceUnit: evidenceUnitFromStoredRow(
          storedRecord(row.canonical_evidence),
        ),
        sourceState: canonicalSourceState({
          currentRevisionId: row.canonical_current_revision_id,
          operation: row.canonical_adapter_operation,
          sourceRevisionId: row.source_revision_id,
        }),
      })),
      ids,
      tenantId,
    );
  }

  const ledger = await readKnowledgeLedger();
  const evidenceById = new Map<string, EvidenceUnitV1>();
  for (const outputCandidate of ledger.sourceLineage?.adapterOutputs || []) {
    const output = sourceAdapterUpsertV1Schema.parse(outputCandidate);
    if (output.tenantId !== tenantId) continue;
    for (const evidenceUnit of output.evidenceUnits) {
      evidenceById.set(evidenceUnit.evidenceUnitId, evidenceUnit);
    }
  }
  const idSet = new Set(ids);
  const currentOutputBySourceItemId = new Map<string, SourceAdapterUpsertV1>();
  for (const outputCandidate of ledger.sourceLineage?.adapterOutputs || []) {
    const output = sourceAdapterUpsertV1Schema.parse(outputCandidate);
    if (
      output.tenantId === tenantId &&
      !currentOutputBySourceItemId.has(output.sourceItem.sourceItemId)
    ) {
      currentOutputBySourceItemId.set(output.sourceItem.sourceItemId, output);
    }
  }
  return orderCanonicalKnowledgeEvidence(
    ledger.chunks
      .filter((chunk) =>
        idSet.has(chunk.id) &&
        normalizeTenantId(chunk.tenantId) === tenantId &&
        Boolean(chunk.evidenceUnitId),
      )
      .flatMap((chunk) => {
        const evidenceUnit = evidenceById.get(chunk.evidenceUnitId!);
        const currentOutput = evidenceUnit
          ? currentOutputBySourceItemId.get(evidenceUnit.sourceItemId)
          : undefined;
        return evidenceUnit && currentOutput
          ? [{
              chunk: sanitizeKnowledgeChunk(chunk),
              evidenceUnit,
              sourceState: canonicalSourceState({
                currentRevisionId:
                  currentOutput.sourceRevision.sourceRevisionId,
                operation: currentOutput.operation,
                sourceRevisionId: evidenceUnit.sourceRevisionId,
              }),
            }]
          : [];
      }),
    ids,
    tenantId,
  );
}

/**
 * Resolves a bounded exact set of canonical evidence units to their current
 * knowledge chunks. Authorization is deliberately left to the caller because
 * the same immutable evidence contract is consumed under several distinct
 * governed purposes.
 */
export async function getCanonicalKnowledgeEvidenceByEvidenceUnitIds(
  evidenceUnitIds: readonly string[],
  options: { tenantId?: string } = {},
): Promise<CanonicalKnowledgeEvidence[]> {
  const tenantId = normalizeTenantId(options.tenantId);
  const ids = [...new Set(
    evidenceUnitIds
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean),
  )].slice(0, 128);
  if (!ids.length) return [];

  const chunkIds = hasDatabaseUrl()
    ? (await (async () => {
        await ensureDatabaseSchema();
        const rows = await getSql()`
          SELECT id, evidence_unit_id
          FROM omni_knowledge_chunks
          WHERE tenant_id = ${tenantId}
            AND evidence_unit_id = ANY(${ids})
          ORDER BY evidence_unit_id COLLATE "C", chunk_index, id COLLATE "C"
        `;
        return rows.map((row) => String(row.id));
      })())
    : (await readKnowledgeLedger()).chunks
        .filter((chunk) =>
          normalizeTenantId(chunk.tenantId) === tenantId &&
          Boolean(chunk.evidenceUnitId) &&
          ids.includes(chunk.evidenceUnitId!)
        )
        .sort((left, right) =>
          left.evidenceUnitId!.localeCompare(right.evidenceUnitId!) ||
          left.chunkIndex - right.chunkIndex ||
          left.id.localeCompare(right.id)
        )
        .map((chunk) => chunk.id);
  const candidates = await getCanonicalKnowledgeEvidenceByChunkIds(
    chunkIds,
    { tenantId },
  );
  const byEvidenceUnitId = new Map<string, CanonicalKnowledgeEvidence>();
  for (const candidate of candidates) {
    if (!byEvidenceUnitId.has(candidate.evidenceUnit.evidenceUnitId)) {
      byEvidenceUnitId.set(candidate.evidenceUnit.evidenceUnitId, candidate);
    }
  }
  return ids.flatMap((id) => {
    const candidate = byEvidenceUnitId.get(id);
    return candidate ? [candidate] : [];
  });
}

export async function searchKnowledge(
  query: string,
  options: SearchKnowledgeOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const limit = options.limit || 8;
  if (isLocalRetrievalEmbeddingSpace(options.queryEmbeddingSpaceId)) {
    const [chunks, documents] = await Promise.all([
      listKnowledgeChunks(500, { tenantId: options.tenantId }),
      listKnowledgeDocuments(500, { tenantId: options.tenantId }),
    ]);
    return rankChunksInMemory(
      chunks,
      new Map(documents.map((document) => [document.id, document])),
      query,
      options,
    ).slice(0, limit);
  }

  if (hasDatabaseUrl()) {
    return (await searchKnowledgeDb(query, {
      ...options,
      queryEmbedding: retrievalEmbeddingSpaceSupportsStoredVectorIndex(
        options.queryEmbeddingSpaceId,
      )
        ? options.queryEmbedding
        : undefined,
    })).slice(0, limit);
  }

  const ledger = await readKnowledgeLedger();
  const tenantId = normalizeTenantId(options.tenantId);
  const documents = ledger.documents
    .filter((document) => normalizeTenantId(document.tenantId) === tenantId)
    .map(sanitizeKnowledgeDocument);
  const chunks = ledger.chunks
    .filter((chunk) => normalizeTenantId(chunk.tenantId) === tenantId)
    .map(sanitizeKnowledgeChunk);
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  return rankChunksInMemory(chunks, documentsById, query, options).slice(0, limit);
}

export async function getKnowledgeStats(options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT COUNT(*)::int AS documents,
             COALESCE(SUM(chunk_count), 0)::int AS chunks,
             COALESCE(SUM(total_characters), 0)::int AS characters,
             (
               SELECT COUNT(*)::int
               FROM omni_knowledge_chunks chunk
               WHERE chunk.tenant_id = ${tenantId}
                 AND jsonb_typeof(chunk.embedding) = 'array'
             ) AS embedded
      FROM omni_knowledge_documents
      WHERE tenant_id = ${tenantId}
    `;

    return {
      documents: Number(rows[0]?.documents || 0),
      chunks: Number(rows[0]?.chunks || 0),
      characters: Number(rows[0]?.characters || 0),
      embedded: Number(rows[0]?.embedded || 0),
    };
  }

  const ledger = await readKnowledgeLedger();
  const documents = ledger.documents.filter((document) => normalizeTenantId(document.tenantId) === tenantId);
  const chunks = ledger.chunks.filter((chunk) => normalizeTenantId(chunk.tenantId) === tenantId);
  return {
    documents: documents.length,
    chunks: chunks.length,
    characters: documents.reduce((sum, document) => sum + document.totalCharacters, 0),
    embedded: chunks.filter((chunk) => chunk.embedding?.length).length,
  };
}

export async function listKnowledgeChunksMissingEmbeddings(
  limit = 48,
  options: { tenantId?: string } = {},
): Promise<KnowledgeChunk[]> {
  const tenantId = normalizeTenantId(options.tenantId);
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 96);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseTenantScope(tenantId, async () => {
      const rows = await getSql()`
        SELECT chunk.*
        FROM omni_knowledge_chunks chunk
        WHERE chunk.tenant_id = ${tenantId}
          AND jsonb_typeof(chunk.embedding) IS DISTINCT FROM 'array'
        ORDER BY chunk.updated_at ASC, chunk.id COLLATE "C"
        LIMIT ${boundedLimit}
      `;
      return rows.map(chunkFromRow);
    });
  }
  const ledger = await readKnowledgeLedger();
  return ledger.chunks
    .filter((chunk) =>
      normalizeTenantId(chunk.tenantId) === tenantId &&
      !chunk.embedding?.length
    )
    .sort((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) ||
      left.id.localeCompare(right.id)
    )
    .slice(0, boundedLimit)
    .map(sanitizeKnowledgeChunk);
}

export async function applyKnowledgeChunkEmbeddingBackfill(input: {
  tenantId: string;
  chunks: readonly Readonly<{
    id: string;
    expectedUpdatedAt: string;
    embedding: readonly number[];
  }>[];
  executionScope: ExecutionScope;
  provider: string;
  model: string;
  dimensions: number;
}) {
  const tenantId = normalizeTenantId(input.tenantId);
  const executionScope = parsePersistedExecutionScope(input.executionScope);
  if (!executionScope) {
    throw new Error("Knowledge embedding backfill requires an execution scope.");
  }
  assertExecutionScopeTenant(executionScope, tenantId);
  if (
    executionScope.executingPrincipalType !== "user" ||
    executionScope.executingPrincipalId !== executionScope.initiatingActorId ||
    executionScope.workspaceId !== null ||
    executionScope.projectId !== null ||
    executionScope.missionId !== null
  ) {
    throw new Error("Knowledge embedding backfill requires an exact user scope.");
  }
  if (!input.chunks.length || input.chunks.length > 96) {
    throw new Error("Knowledge embedding backfill requires one to 96 chunks.");
  }
  const payload = input.chunks.map((chunk) => {
    const embedding = chunk.embedding.map(Number);
    if (
      !chunk.id.trim() ||
      !Number.isInteger(input.dimensions) ||
      input.dimensions < 1 ||
      embedding.length !== input.dimensions ||
      embedding.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("Knowledge embedding backfill received an invalid vector.");
    }
    return {
      id: chunk.id,
      expected_updated_at: new Date(chunk.expectedUpdatedAt).toISOString(),
      embedding,
    };
  });
  const chunkSetSha256 = sourceContractSha256(payload.map((chunk) => ({
    id: chunk.id,
    expectedUpdatedAt: chunk.expected_updated_at,
  })));

  if (!hasDatabaseUrl()) {
    const byId = new Map(payload.map((chunk) => [chunk.id, chunk]));
    await updateJsonFile<KnowledgeLedger>(
      getKnowledgeFile(),
      { documents: [], chunks: [] },
      (ledger) => ({
        ...ledger,
        chunks: ledger.chunks.map((chunk) => {
          const update = byId.get(chunk.id);
          return update && chunk.updatedAt === update.expected_updated_at
            ? { ...chunk, embedding: update.embedding }
            : chunk;
        }),
      }),
    );
    return { updatedCount: payload.length, chunkSetSha256 };
  }

  await ensureDatabaseSchema();
  const updatedIds = await runWithDatabaseTenantScope(tenantId, () =>
    getSql().transaction(async (sql: RagSqlClient) => {
      const rows = await sql`
        UPDATE omni_knowledge_chunks chunk
        SET embedding = input.embedding
        FROM jsonb_to_recordset(${payload}::jsonb) AS input(
          id text,
          expected_updated_at timestamptz,
          embedding jsonb
        )
        WHERE chunk.tenant_id = ${tenantId}
          AND chunk.id = input.id
          AND chunk.updated_at = input.expected_updated_at
          AND jsonb_typeof(chunk.embedding) IS DISTINCT FROM 'array'
        RETURNING chunk.id
      `;
      if (rows.length !== payload.length) {
        throw new Error(
          "Knowledge changed during embedding backfill; refresh and retry.",
        );
      }
      await appendScopedDomainEvent({
        id: `knowledge_embedding_backfill_${sourceContractSha256({
          tenantId,
          chunkSetSha256,
          correlationId: executionScope.correlationId,
        })}`,
        streamId: `knowledge-index:${executionScope.initiatingActorId}`,
        type: "knowledge.embedding_backfill.completed",
        executionScope,
        payload: {
          schemaVersion: 1,
          chunkSetSha256,
          updatedCount: rows.length,
          provider: input.provider,
          model: input.model,
          dimensions: input.dimensions,
        },
      }, { sql });
      return rows.map((row) => String(row.id));
    }) as Promise<string[]>
  );

  const vectors = payload
    .filter((chunk) => updatedIds.includes(chunk.id))
    .map((chunk) => ({
      id: chunk.id,
      embedding: toVectorLiteral(chunk.embedding as number[]),
    }))
    .filter((chunk): chunk is { id: string; embedding: string } =>
      Boolean(chunk.embedding)
    );
  if (vectors.length) {
    try {
      await runWithDatabaseTenantScope(tenantId, () => getSql()`
        UPDATE omni_knowledge_chunks chunk
        SET embedding_vector = input.embedding::vector
        FROM jsonb_to_recordset(${vectors}::jsonb) AS input(
          id text,
          embedding text
        )
        WHERE chunk.tenant_id = ${tenantId}
          AND chunk.id = input.id
      `);
    } catch {
      // JSON embeddings remain authoritative when pgvector is unavailable.
    }
  }
  return { updatedCount: updatedIds.length, chunkSetSha256 };
}

async function insertKnowledgeDocumentDb(
  document: KnowledgeDocument,
  chunks: KnowledgeChunk[],
  canonicalSourceWrite?: CanonicalTextSourceWrite,
  captureIngestGuard?: CaptureIngestGuard,
) {
  await ensureDatabaseSchema();
  const sql = getSql();
  const persistence = await sql.transaction(async (transaction: RagSqlClient) => {
    if (captureIngestGuard) {
      await lockActiveCaptureIngest(transaction, captureIngestGuard);
    }
    const insertedDocuments = await transaction`
      INSERT INTO omni_knowledge_documents (
        id, tenant_id, title, source, source_type, tags, content_hash, chunk_count, total_characters, metadata, created_at, updated_at
      )
      VALUES (
        ${document.id}, ${document.tenantId}, ${document.title}, ${document.source}, ${document.sourceType}, ${document.tags},
        ${document.contentHash}, ${document.chunkCount}, ${document.totalCharacters}, ${document.metadata}::jsonb,
        ${document.createdAt}, ${document.updatedAt}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;

    const documentInserted = insertedDocuments.length === 1;
    if (!documentInserted && canonicalSourceWrite) {
      // Canonicalizing an exact legacy document can update a large evidence
      // set in one atomic retry. Keep the ordinary 15-second SQL bound for
      // every new write, but give this finite repair transaction the runtime's
      // documented maximum so historical connector backfills make progress.
      await transaction`
        SELECT set_config('statement_timeout', '60000', true)
      `;
    }
    const persistedLineage = documentInserted
      ? canonicalSourceWrite
        ? await persistCanonicalSourceWrite(transaction, canonicalSourceWrite, {
            documentId: document.id,
          })
        : undefined
      : await recoverExistingKnowledgeLineage(
          transaction,
          document,
          chunks,
          canonicalSourceWrite,
        );
    if (documentInserted && persistedLineage) {
      const boundDocuments = await transaction`
        UPDATE omni_knowledge_documents
        SET source_item_id = ${persistedLineage.sourceItemId},
            source_revision_id = ${persistedLineage.sourceRevisionId}
        WHERE tenant_id = ${document.tenantId}
          AND id = ${document.id}
          AND source_item_id IS NULL
          AND source_revision_id IS NULL
        RETURNING id
      `;
      if (boundDocuments.length !== 1) {
        throw new Error(
          "Knowledge document could not be bound to canonical source lineage.",
        );
      }
    }

    const persistedChunks = persistedLineage ? chunks : chunks.map(withoutChunkLineage);
    const chunkPayload = persistedChunks.map((chunk) => ({
      id: chunk.id,
      tenant_id: chunk.tenantId,
      document_id: chunk.documentId,
      source_revision_id: chunk.sourceRevisionId || null,
      evidence_unit_id: chunk.evidenceUnitId || null,
      chunk_index: chunk.chunkIndex,
      title: chunk.title,
      content: chunk.content,
      tags: chunk.tags,
      source: chunk.source,
      token_estimate: chunk.tokenEstimate,
      character_count: chunk.characterCount,
      embedding: chunk.embedding || null,
      metadata: chunk.metadata,
      created_at: chunk.createdAt,
      updated_at: chunk.updatedAt,
    }));

    if (documentInserted && chunkPayload.length) {
      const insertedChunks = await transaction`
        INSERT INTO omni_knowledge_chunks (
          id, tenant_id, document_id, source_revision_id, evidence_unit_id,
          chunk_index, title, content, tags, source, token_estimate,
          character_count, embedding, metadata, created_at, updated_at
        )
        SELECT
          id, tenant_id, document_id, source_revision_id, evidence_unit_id,
          chunk_index, title, content, tags, source, token_estimate,
          character_count, embedding, metadata, created_at, updated_at
        FROM jsonb_to_recordset(${chunkPayload}::jsonb) AS input(
          id text,
          tenant_id text,
          document_id text,
          source_revision_id text,
          evidence_unit_id text,
          chunk_index integer,
          title text,
          content text,
          tags text[],
          source text,
          token_estimate integer,
          character_count integer,
          embedding jsonb,
          metadata jsonb,
          created_at timestamptz,
          updated_at timestamptz
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      if (insertedChunks.length !== chunkPayload.length) {
        throw new Error(
          "Knowledge chunks could not be inserted as one complete document.",
        );
      }
    }
    return { lineage: persistedLineage, inserted: documentInserted };
  }) as {
    lineage: PersistedKnowledgeLineage | undefined;
    inserted: boolean;
  };
  const vectors = (persistence.inserted ? chunks : [])
    .map((chunk) => {
      const embedding = toVectorLiteral(chunk.embedding);
      return embedding ? { id: chunk.id, embedding } : null;
    })
    .filter(
      (item): item is { id: string; embedding: string } => Boolean(item),
    );
  if (vectors.length) {
    try {
      await sql`
        UPDATE omni_knowledge_chunks chunk
        SET embedding_vector = vectors.embedding::vector
        FROM jsonb_to_recordset(${vectors}::jsonb) AS vectors(
          id text,
          embedding text
        )
        WHERE chunk.id = vectors.id
          AND chunk.tenant_id = ${document.tenantId}
      `;
    } catch {
      // pgvector is optional; JSON embeddings still support similarity.
    }
  }
  return persistence.lineage as PersistedKnowledgeLineage | undefined;
}

async function recoverExistingKnowledgeLineage(
  sql: RagSqlClient,
  requestedDocument: KnowledgeDocument,
  requestedChunks: readonly KnowledgeChunk[],
  write?: CanonicalTextSourceWrite,
) {
  const documentRows = await sql`
    SELECT *
    FROM omni_knowledge_documents
    WHERE tenant_id = ${requestedDocument.tenantId}
      AND id = ${requestedDocument.id}
    LIMIT 1
  `;
  if (documentRows.length !== 1) {
    throw new Error(
      "Knowledge document ID conflicts outside the active tenant scope.",
    );
  }
  const existingDocument = documentFromRow(documentRows[0]);
  const chunkRows = await sql`
    SELECT *
    FROM omni_knowledge_chunks
    WHERE tenant_id = ${requestedDocument.tenantId}
      AND document_id = ${requestedDocument.id}
    ORDER BY chunk_index ASC
  `;
  const existingChunks = chunkRows.map(chunkFromRow);
  assertStoredKnowledgePayload(
    existingDocument,
    existingChunks,
    requestedDocument,
    requestedChunks,
  );

  const hasSourceItem = Boolean(existingDocument.sourceItemId);
  const hasSourceRevision = Boolean(existingDocument.sourceRevisionId);
  if (!hasSourceItem && !hasSourceRevision) {
    if (
      existingChunks.some(
        (chunk) => chunk.sourceRevisionId || chunk.evidenceUnitId,
      )
    ) {
      throw new Error("Legacy knowledge document has partial source lineage.");
    }
    if (!write) return undefined;
    const repairedLineage =
      await recoverCompatibleCurrentKnowledgeLineage(
        sql,
        requestedDocument,
        write,
      ) ||
      await persistCanonicalSourceWrite(sql, write, {
        documentId: requestedDocument.id,
      });
    const repairedDocuments = await sql`
      UPDATE omni_knowledge_documents
      SET source_item_id = ${repairedLineage.sourceItemId},
          source_revision_id = ${repairedLineage.sourceRevisionId}
      WHERE tenant_id = ${requestedDocument.tenantId}
        AND id = ${requestedDocument.id}
        AND source_item_id IS NULL
        AND source_revision_id IS NULL
      RETURNING id
    `;
    if (repairedDocuments.length !== 1) {
      throw new Error(
        "Legacy knowledge document could not be bound to canonical source lineage.",
      );
    }
    const chunkLineage = requestedChunks.map((chunk) => ({
      id: chunk.id,
      chunk_index: chunk.chunkIndex,
      source_revision_id: repairedLineage.sourceRevisionId,
      evidence_unit_id:
        repairedLineage.evidenceUnitIdsByChunkIndex[chunk.chunkIndex],
    }));
    const repairedChunks = await sql`
      UPDATE omni_knowledge_chunks chunk
      SET source_revision_id = lineage.source_revision_id,
          evidence_unit_id = lineage.evidence_unit_id
      FROM jsonb_to_recordset(${chunkLineage}::jsonb) AS lineage(
        id text,
        chunk_index integer,
        source_revision_id text,
        evidence_unit_id text
      )
      WHERE chunk.tenant_id = ${requestedDocument.tenantId}
        AND chunk.document_id = ${requestedDocument.id}
        AND chunk.id = lineage.id
        AND chunk.chunk_index = lineage.chunk_index
        AND chunk.source_revision_id IS NULL
        AND chunk.evidence_unit_id IS NULL
      RETURNING chunk.id
    `;
    if (repairedChunks.length !== requestedChunks.length) {
      throw new Error(
        "Legacy knowledge chunks could not be bound to canonical evidence lineage.",
      );
    }
    return repairedLineage;
  }
  if (!hasSourceItem || !hasSourceRevision) {
    throw new Error("Stored knowledge document has partial source lineage.");
  }
  if (!write) {
    throw new Error(
      "Canonical knowledge document cannot be retried without source lineage.",
    );
  }

  const output = sourceAdapterUpsertV1Schema.parse(write.adapterOutput);
  if (
    existingDocument.sourceItemId !== output.sourceItem.sourceItemId ||
    existingDocument.sourceRevisionId !== output.sourceRevision.sourceRevisionId
  ) {
    throw new Error(
      "Knowledge document ID is already bound to different source lineage.",
    );
  }
  assertStoredChunkLineage(existingChunks, requestedChunks, write);
  await assertCanonicalAdapterOutputReceipt(sql, output);

  const revisionRows = await sql`
    SELECT source_item_id, source_revision_sha256, tenant_id, connection_id,
           adapter_output_id, adapter_output_sha256, adapter_operation,
           adapter_id, adapter_version_id, adapter_config_sha256,
           adapter_event_key_sha256, adapter_observed_at
    FROM omni_source_revisions
    WHERE tenant_id = ${requestedDocument.tenantId}
      AND id = ${output.sourceRevision.sourceRevisionId}
    LIMIT 1
  `;
  if (
    revisionRows.length !== 1 ||
    String(revisionRows[0].source_item_id) !== output.sourceItem.sourceItemId ||
    String(revisionRows[0].source_revision_sha256) !==
      output.sourceRevision.sourceRevisionSha256 ||
    !storedAdapterEnvelopeMatches(revisionRows[0], output)
  ) {
    throw new Error(
      "Stored source revision does not match the canonical adapter output.",
    );
  }

  const evidenceIds = [...write.evidenceUnitIdsByChunkIndex];
  if (evidenceIds.length) {
    const evidenceRows = await sql`
      SELECT id, source_revision_id, evidence_unit_sha256,
             tenant_id, connection_id,
             adapter_output_id, adapter_output_sha256, adapter_operation,
             adapter_id, adapter_version_id, adapter_config_sha256,
             adapter_event_key_sha256, adapter_observed_at
      FROM omni_evidence_units
      WHERE tenant_id = ${requestedDocument.tenantId}
        AND id = ANY(${evidenceIds})
    `;
    const evidenceById = new Map(
      evidenceRows.map((row) => [String(row.id), row]),
    );
    for (const evidence of output.evidenceUnits) {
      const row = evidenceById.get(evidence.evidenceUnitId);
      if (
        !row ||
        String(row.source_revision_id) !== output.sourceRevision.sourceRevisionId ||
        String(row.evidence_unit_sha256) !== evidence.evidenceUnitSha256 ||
        !storedAdapterEnvelopeMatches(row, output)
      ) {
        throw new Error(
          "Stored evidence does not match the canonical adapter output.",
        );
      }
    }
    if (evidenceById.size !== output.evidenceUnits.length) {
      throw new Error(
        "Stored canonical evidence set is incomplete or contains conflicts.",
      );
    }
  }

  return expectedKnowledgeLineage(write);
}

async function recoverCompatibleCurrentKnowledgeLineage(
  sql: RagSqlClient,
  requestedDocument: KnowledgeDocument,
  write: CanonicalTextSourceWrite,
): Promise<PersistedKnowledgeLineage | undefined> {
  const output = sourceAdapterUpsertV1Schema.parse(write.adapterOutput);
  const requestedItem = output.sourceItem;
  const requestedRevision = output.sourceRevision;
  const rows = await sql`
    SELECT revision.*
    FROM omni_source_items item
    JOIN omni_source_revisions revision
      ON revision.tenant_id = item.tenant_id
     AND revision.id = item.current_revision_id
    WHERE item.tenant_id = ${requestedDocument.tenantId}
      AND item.id = ${requestedItem.sourceItemId}
      AND item.owner_actor_id = ${requestedItem.ownerActorId}
      AND item.connection_id = ${requestedItem.connectionId}
      AND item.visibility = ${requestedItem.visibility}
      AND item.sensitivity = ${requestedItem.sensitivity}
      AND item.permission_set_sha256 = ${requestedItem.permissionSetSha256}
      AND item.purpose_set_sha256 = ${requestedItem.purposeSetSha256}
      AND item.source_kind = ${requestedItem.sourceKind}
      AND item.provider_item_key_sha256 = ${requestedItem.providerItemKeySha256}
    LIMIT 1
  `;
  const current = rows[0];
  if (
    !current ||
    current.source_item_id !== requestedItem.sourceItemId ||
    current.owner_actor_id !== requestedRevision.ownerActorId ||
    current.connection_id !== requestedRevision.connectionId ||
    current.visibility !== requestedRevision.visibility ||
    current.sensitivity !== requestedRevision.sensitivity ||
    current.permission_set_sha256 !== requestedRevision.permissionSetSha256 ||
    current.purpose_set_sha256 !== requestedRevision.purposeSetSha256 ||
    current.source_kind !== requestedRevision.sourceKind ||
    current.provider_item_key_sha256 !==
      requestedRevision.providerItemKeySha256 ||
    current.content_sha256 !== requestedRevision.contentSha256 ||
    Number(current.content_byte_length) !==
      requestedRevision.contentByteLength ||
    current.media_type !== requestedRevision.mediaType ||
    current.adapter_id !== output.adapterId
  ) {
    return undefined;
  }

  const evidenceRows = await sql`
    SELECT *
    FROM omni_evidence_units
    WHERE tenant_id = ${requestedDocument.tenantId}
      AND source_item_id = ${requestedItem.sourceItemId}
      AND source_revision_id = ${String(current.id)}
    ORDER BY id COLLATE "C"
  `;
  if (evidenceRows.length !== output.evidenceUnits.length) {
    return undefined;
  }
  const currentEvidence = evidenceRows.map(evidenceUnitFromStoredRow);
  const currentByPassage = new Map<string, EvidenceUnitV1>();
  for (const evidence of currentEvidence) {
    const key = `${evidence.evidenceContentSha256}:${evidence.locatorSha256}`;
    if (currentByPassage.has(key)) return undefined;
    currentByPassage.set(key, evidence);
  }
  const requestedEvidenceById = new Map(
    output.evidenceUnits.map((evidence) => [evidence.evidenceUnitId, evidence]),
  );
  const evidenceUnitIdsByChunkIndex: string[] = [];
  for (const requestedEvidenceId of write.evidenceUnitIdsByChunkIndex) {
    const requestedEvidence = requestedEvidenceById.get(requestedEvidenceId);
    if (!requestedEvidence) return undefined;
    const currentEvidenceUnit = currentByPassage.get(
      `${requestedEvidence.evidenceContentSha256}:${requestedEvidence.locatorSha256}`,
    );
    if (!currentEvidenceUnit) return undefined;
    evidenceUnitIdsByChunkIndex.push(currentEvidenceUnit.evidenceUnitId);
  }
  if (
    new Set(evidenceUnitIdsByChunkIndex).size !== currentEvidence.length
  ) {
    return undefined;
  }
  return Object.freeze({
    sourceItemId: requestedItem.sourceItemId,
    sourceRevisionId: String(current.id),
    evidenceUnitIdsByChunkIndex: Object.freeze(
      evidenceUnitIdsByChunkIndex,
    ),
  });
}

async function searchKnowledgeDb(
  query: string,
  options: SearchKnowledgeOptions,
): Promise<KnowledgeSearchResult[]> {
  await ensureDatabaseSchema();
  const limit = options.limit || 8;
  const candidateLimit = hasTagFilter(options) ? Math.min(limit * 5, 200) : limit;
  const queryText = query.trim();
  const tenantId = normalizeTenantId(options.tenantId);
  const vector = toVectorLiteral(options.queryEmbedding);

  if (vector) {
    try {
      const rows = await getSql()`
        SELECT c.*,
               d.title AS document_title,
               d.source_item_id AS document_source_item_id,
               d.source_revision_id AS document_source_revision_id,
               d.source_type AS document_source_type,
               d.content_hash AS document_content_hash,
               d.chunk_count AS document_chunk_count,
               d.total_characters AS document_total_characters,
               d.metadata AS document_metadata,
               d.created_at AS document_created_at,
               d.updated_at AS document_updated_at,
               GREATEST(0, 1 - (c.embedding_vector <=> ${vector}::vector)) AS vector_score,
               CASE
                 WHEN ${queryText} = '' THEN 0
                 ELSE ts_rank_cd(
                   to_tsvector('english', c.title || ' ' || c.content),
                   plainto_tsquery('english', ${queryText})
                 )
               END AS lexical_score,
               1 / (1 + EXTRACT(EPOCH FROM (NOW() - c.updated_at)) / 604800) AS recency_score
        FROM omni_knowledge_chunks c
        JOIN omni_knowledge_documents d ON d.id = c.document_id
        WHERE c.tenant_id = ${tenantId}
          AND d.tenant_id = ${tenantId}
          AND c.embedding_vector IS NOT NULL
        ORDER BY (
          (0.68 * GREATEST(0, 1 - (c.embedding_vector <=> ${vector}::vector))) +
          (0.24 * CASE
            WHEN ${queryText} = '' THEN 0
            ELSE ts_rank_cd(
              to_tsvector('english', c.title || ' ' || c.content),
              plainto_tsquery('english', ${queryText})
            )
          END) +
          (0.08 * (1 / (1 + EXTRACT(EPOCH FROM (NOW() - c.updated_at)) / 604800)))
        ) DESC
        LIMIT ${candidateLimit}
      `;
      const results = filterKnowledgeResultsByTags(rows.map(knowledgeResultFromRow), options.tags);
      if (results.length || !options.queryEmbedding) {
        return results.slice(0, limit);
      }
      return searchKnowledgeJsonEmbeddingDb(query, options, limit, tenantId);
    } catch {
      const lexicalResults = await searchKnowledgeLexicalDb(queryText, candidateLimit, tenantId, options.tags);
      if (lexicalResults.length || !options.queryEmbedding) {
        return lexicalResults.slice(0, limit);
      }
      return searchKnowledgeJsonEmbeddingDb(query, options, limit, tenantId);
    }
  }

  return (await searchKnowledgeLexicalDb(queryText, candidateLimit, tenantId, options.tags)).slice(0, limit);
}

async function searchKnowledgeLexicalDb(query: string, limit: number, tenantId: string, tags?: string[]) {
  const rows = await getSql()`
    SELECT c.*,
           d.title AS document_title,
           d.source_item_id AS document_source_item_id,
           d.source_revision_id AS document_source_revision_id,
           d.source_type AS document_source_type,
           d.content_hash AS document_content_hash,
           d.chunk_count AS document_chunk_count,
           d.total_characters AS document_total_characters,
           d.metadata AS document_metadata,
           d.created_at AS document_created_at,
           d.updated_at AS document_updated_at,
           CASE
             WHEN ${query} = '' THEN 0
             ELSE ts_rank_cd(
               to_tsvector('english', c.title || ' ' || c.content),
               plainto_tsquery('english', ${query})
             )
           END AS lexical_score,
           1 / (1 + EXTRACT(EPOCH FROM (NOW() - c.updated_at)) / 604800) AS recency_score
    FROM omni_knowledge_chunks c
    JOIN omni_knowledge_documents d ON d.id = c.document_id
    WHERE c.tenant_id = ${tenantId}
      AND d.tenant_id = ${tenantId}
      AND (
        ${query} = ''
        OR to_tsvector('english', c.title || ' ' || c.content) @@ plainto_tsquery('english', ${query})
      )
    ORDER BY lexical_score DESC, c.updated_at DESC
    LIMIT ${limit}
  `;
  return filterKnowledgeResultsByTags(rows.map(knowledgeResultFromRow), tags);
}

async function searchKnowledgeJsonEmbeddingDb(
  query: string,
  options: SearchKnowledgeOptions,
  limit: number,
  tenantId: string,
) {
  const rows = await getSql()`
    SELECT c.*,
           d.title AS document_title,
           d.source_item_id AS document_source_item_id,
           d.source_revision_id AS document_source_revision_id,
           d.source_type AS document_source_type,
           d.content_hash AS document_content_hash,
           d.chunk_count AS document_chunk_count,
           d.total_characters AS document_total_characters,
           d.metadata AS document_metadata,
           d.created_at AS document_created_at,
           d.updated_at AS document_updated_at
    FROM omni_knowledge_chunks c
    JOIN omni_knowledge_documents d ON d.id = c.document_id
    WHERE c.tenant_id = ${tenantId}
      AND d.tenant_id = ${tenantId}
      AND jsonb_typeof(c.embedding) = 'array'
    ORDER BY c.updated_at DESC
    LIMIT 500
  `;
  const chunks = rows.map(chunkFromRow);
  const documentsById = new Map<string, KnowledgeDocument>();
  for (const row of rows) {
    const chunk = chunkFromRow(row);
    documentsById.set(chunk.documentId, {
      id: chunk.documentId,
      tenantId,
      sourceItemId: optionalString(row.document_source_item_id),
      sourceRevisionId: optionalString(row.document_source_revision_id),
      title: String(row.document_title || ""),
      source: chunk.source,
      sourceType: String(row.document_source_type || "text") as KnowledgeSourceType,
      tags: chunk.tags,
      contentHash: String(row.document_content_hash || ""),
      chunkCount: Number(row.document_chunk_count || 0),
      totalCharacters: Number(row.document_total_characters || 0),
      metadata: parseMetadata(row.document_metadata),
      createdAt: normalizeDate(row.document_created_at),
      updatedAt: normalizeDate(row.document_updated_at),
    });
  }

  return rankChunksInMemory(chunks, documentsById, query, options).slice(0, limit);
}

function rankChunksInMemory(
  chunks: KnowledgeChunk[],
  documentsById: Map<string, KnowledgeDocument>,
  query: string,
  options: SearchKnowledgeOptions,
) {
  const terms = tokenize(query);
  const now = Date.now();
  const requiredTags = normalizeTags(options.tags || []);

  return chunks
    .filter((chunk) => requiredTags.length === 0 || requiredTags.every((tag) => chunk.tags.includes(tag)))
    .map((chunk) => {
      const text = `${chunk.title} ${chunk.content} ${chunk.tags.join(" ")}`;
      const chunkTerms = tokenize(text);
      const overlap = terms.filter((term) => chunkTerms.includes(term));
      const lexicalScore = terms.length === 0 ? 0 : overlap.length / terms.length;
      const vectorScore =
        options.queryEmbedding &&
          isLocalRetrievalEmbeddingSpace(options.queryEmbeddingSpaceId)
          ? Math.max(
              0,
              retrievalEmbeddingCosine(
                options.queryEmbedding,
                embedLocalMultilingualTexts([text])[0],
              ),
            )
          : options.queryEmbedding &&
              retrievalEmbeddingSpaceSupportsStoredVectorIndex(
                options.queryEmbeddingSpaceId,
              ) &&
              chunk.embedding
            ? Math.max(
                0,
                cosineSimilarity(options.queryEmbedding, chunk.embedding),
              )
          : 0;
      const ageMs = Math.max(0, now - new Date(chunk.updatedAt).getTime());
      const recencyScore = 1 / (1 + ageMs / (7 * 24 * 60 * 60 * 1000));
      const score = vectorScore * 0.68 + lexicalScore * 0.24 + recencyScore * 0.08;

      return {
        chunk,
        document: documentsById.get(chunk.documentId),
        score,
        vectorScore,
        lexicalScore,
        recencyScore,
        reasons: buildReasons({ overlap, vectorScore, lexicalScore, recencyScore }),
      };
    })
    .filter((result) => result.score > 0.04)
    .sort((a, b) => b.score - a.score);
}

function knowledgeResultFromRow(row: Record<string, unknown>): KnowledgeSearchResult {
  const chunk = chunkFromRow(row);
  const vectorScore = Number(row.vector_score || 0);
  const lexicalScore = Number(row.lexical_score || 0);
  const recencyScore = Number(row.recency_score || 0);
  const score = vectorScore * 0.68 + lexicalScore * 0.24 + recencyScore * 0.08;

  return {
    chunk,
    document: {
      id: chunk.documentId,
      tenantId: String(row.tenant_id || row.document_tenant_id || "default"),
      sourceItemId: optionalString(row.document_source_item_id),
      sourceRevisionId: optionalString(row.document_source_revision_id),
      title: String(row.document_title || ""),
      source: chunk.source,
      sourceType: String(row.document_source_type || "text") as KnowledgeSourceType,
      tags: chunk.tags,
      contentHash: String(row.document_content_hash || ""),
      chunkCount: Number(row.document_chunk_count || 0),
      totalCharacters: Number(row.document_total_characters || 0),
      metadata: parseMetadata(row.document_metadata),
      createdAt: normalizeDate(row.document_created_at),
      updatedAt: normalizeDate(row.document_updated_at),
    },
    score,
    vectorScore,
    lexicalScore,
    recencyScore,
    reasons: buildReasons({ overlap: [], vectorScore, lexicalScore, recencyScore }),
  };
}

function documentFromRow(row: Record<string, unknown>): KnowledgeDocument {
  return sanitizeKnowledgeDocument({
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
    sourceItemId: optionalString(row.source_item_id),
    sourceRevisionId: optionalString(row.source_revision_id),
    title: String(row.title || ""),
    source: String(row.source || ""),
    sourceType: String(row.source_type || "text") as KnowledgeSourceType,
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    contentHash: String(row.content_hash || ""),
    chunkCount: Number(row.chunk_count || 0),
    totalCharacters: Number(row.total_characters || 0),
    metadata: parseMetadata(row.metadata),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  });
}

function chunkFromRow(row: Record<string, unknown>): KnowledgeChunk {
  return sanitizeKnowledgeChunk({
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
    documentId: String(row.document_id),
    sourceRevisionId: optionalString(row.source_revision_id),
    evidenceUnitId: optionalString(row.evidence_unit_id),
    chunkIndex: Number(row.chunk_index || 0),
    title: String(row.title || ""),
    content: String(row.content || ""),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    source: String(row.source || ""),
    tokenEstimate: Number(row.token_estimate || 0),
    characterCount: Number(row.character_count || 0),
    embedding: parseEmbedding(row.embedding),
    metadata: parseMetadata(row.metadata),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  });
}

function sanitizeKnowledgeDocument(
  document: KnowledgeDocument,
): KnowledgeDocument {
  return {
    ...document,
    title: String(redactSensitive(document.title)).slice(0, 240),
    source: String(redactSensitive(document.source)).slice(0, 2_000),
    tags: normalizeTags(
      document.tags.map((tag) => String(redactSensitive(tag))),
    ),
    metadata: redactSensitive(document.metadata) as Record<string, unknown>,
  };
}

function sanitizeKnowledgeChunk(chunk: KnowledgeChunk): KnowledgeChunk {
  return {
    ...chunk,
    title: String(redactSensitive(chunk.title)).slice(0, 280),
    content: String(redactSensitive(chunk.content)),
    tags: normalizeTags(
      chunk.tags.map((tag) => String(redactSensitive(tag))),
    ),
    source: String(redactSensitive(chunk.source)).slice(0, 2_000),
    metadata: redactSensitive(chunk.metadata) as Record<string, unknown>,
  };
}

function withoutDocumentLineage(
  document: KnowledgeDocument,
): KnowledgeDocument {
  const {
    sourceItemId: _sourceItemId,
    sourceRevisionId: _sourceRevisionId,
    ...legacyDocument
  } = document;
  void _sourceItemId;
  void _sourceRevisionId;
  return legacyDocument;
}

function assertCanonicalKnowledgeLineage(
  content: string,
  document: KnowledgeDocument,
  chunks: readonly KnowledgeChunk[],
  write: CanonicalTextSourceWrite,
) {
  const output = sourceAdapterUpsertV1Schema.parse(write.adapterOutput);
  const revision = output.sourceRevision;
  if (
    document.sourceItemId !== output.sourceItem.sourceItemId ||
    document.sourceRevisionId !== revision.sourceRevisionId ||
    document.contentHash !== revision.contentSha256 ||
    Buffer.byteLength(content, "utf8") !== revision.contentByteLength
  ) {
    throw new Error(
      "Canonical source revision does not exactly match the knowledge document.",
    );
  }
  if (
    chunks.length !== output.evidenceUnits.length ||
    chunks.length !== write.evidenceUnitIdsByChunkIndex.length
  ) {
    throw new Error(
      "Canonical source lineage must bind every knowledge chunk exactly once.",
    );
  }

  const normalizedContent = normalizeTextForChunking(content);
  const containerSha256 = hashContent(normalizedContent);
  const evidenceById = new Map(
    output.evidenceUnits.map((evidence) => [evidence.evidenceUnitId, evidence]),
  );
  const seenIndexes = new Set<number>();
  const seenEvidence = new Set<string>();
  for (const chunk of chunks) {
    if (
      !Number.isInteger(chunk.chunkIndex) ||
      chunk.chunkIndex < 0 ||
      chunk.chunkIndex >= chunks.length ||
      seenIndexes.has(chunk.chunkIndex)
    ) {
      throw new Error(
        "Canonical knowledge chunks require contiguous zero-based indexes.",
      );
    }
    seenIndexes.add(chunk.chunkIndex);
    const evidenceUnitId =
      write.evidenceUnitIdsByChunkIndex[chunk.chunkIndex];
    const evidence = evidenceById.get(evidenceUnitId);
    if (!evidence || seenEvidence.has(evidenceUnitId)) {
      throw new Error(
        "Canonical knowledge chunks require a one-to-one evidence mapping.",
      );
    }
    seenEvidence.add(evidenceUnitId);
    if (
      chunk.sourceRevisionId !== revision.sourceRevisionId ||
      chunk.evidenceUnitId !== evidenceUnitId ||
      evidence.evidenceContentSha256 !== hashContent(chunk.content) ||
      evidence.evidenceByteLength !== Buffer.byteLength(chunk.content, "utf8")
    ) {
      throw new Error(
        "Canonical evidence does not exactly match its knowledge chunk.",
      );
    }
    const locator = evidence.locator;
    const locatorMatches = locator.kind === "text_span"
      ? locator.offsetUnit === "utf16_code_unit" &&
        locator.containerLength === normalizedContent.length &&
        locator.containerSha256 === containerSha256 &&
        normalizedContent.slice(
          locator.startOffset,
          locator.endOffsetExclusive,
        ) === chunk.content
      : structuredLocatorMatchesSourceKind(locator.kind, revision.sourceKind);
    if (!locatorMatches) {
      throw new Error(
        "Canonical evidence locator does not resolve to its knowledge chunk.",
      );
    }
  }
  if (
    seenIndexes.size !== chunks.length ||
    seenEvidence.size !== output.evidenceUnits.length
  ) {
    throw new Error(
      "Canonical knowledge lineage is incomplete or contains duplicate evidence.",
    );
  }
}

function structuredLocatorMatchesSourceKind(
  locatorKind: Exclude<EvidenceUnitV1["locator"]["kind"], "text_span">,
  sourceKind: EvidenceUnitV1["sourceKind"],
) {
  if (locatorKind === "page") {
    return ["document", "file", "capture"].includes(sourceKind);
  }
  if (locatorKind === "sheet_range") return sourceKind === "spreadsheet";
  if (locatorKind === "slide") return sourceKind === "presentation";
  if (locatorKind === "email_section") return sourceKind === "email";
  if (locatorKind === "image_region") return sourceKind === "image";
  return sourceKind === "audio" || sourceKind === "video";
}

function recoverFileKnowledgeLineage(
  ledger: KnowledgeLedger,
  existingDocument: KnowledgeDocument,
  existingChunks: readonly KnowledgeChunk[],
  requestedDocument: KnowledgeDocument,
  requestedChunks: readonly KnowledgeChunk[],
  write?: CanonicalTextSourceWrite,
): PersistedKnowledgeLineage | undefined {
  assertStoredKnowledgePayload(
    existingDocument,
    existingChunks,
    requestedDocument,
    requestedChunks,
  );
  const hasSourceItem = Boolean(existingDocument.sourceItemId);
  const hasSourceRevision = Boolean(existingDocument.sourceRevisionId);
  if (!hasSourceItem && !hasSourceRevision) {
    if (!write) return undefined;
    const output = sourceAdapterUpsertV1Schema.parse(write.adapterOutput);
    ledger.sourceLineage = mergeCanonicalSourceLedger(
      ledger.sourceLineage,
      write,
    );
    existingDocument.sourceItemId = output.sourceItem.sourceItemId;
    existingDocument.sourceRevisionId = output.sourceRevision.sourceRevisionId;
    for (const chunk of existingChunks) {
      chunk.sourceRevisionId = output.sourceRevision.sourceRevisionId;
      chunk.evidenceUnitId =
        write.evidenceUnitIdsByChunkIndex[chunk.chunkIndex];
    }
    return expectedKnowledgeLineage(write);
  }
  if (!hasSourceItem || !hasSourceRevision) {
    throw new Error("Stored knowledge document has partial source lineage.");
  }
  if (!write) {
    throw new Error(
      "Canonical knowledge document cannot be retried without source lineage.",
    );
  }

  const output = sourceAdapterUpsertV1Schema.parse(write.adapterOutput);
  if (
    existingDocument.sourceItemId !== output.sourceItem.sourceItemId ||
    existingDocument.sourceRevisionId !== output.sourceRevision.sourceRevisionId
  ) {
    throw new Error(
      "Knowledge document ID is already bound to different source lineage.",
    );
  }
  assertStoredChunkLineage(existingChunks, requestedChunks, write);
  const storedOutput = ledger.sourceLineage?.adapterOutputs
    .map((candidate) => sourceAdapterUpsertV1Schema.parse(candidate))
    .find((candidate) => candidate.adapterOutputId === output.adapterOutputId);
  if (
    !storedOutput ||
    storedOutput.adapterOutputSha256 !== output.adapterOutputSha256
  ) {
    throw new Error(
      "Stored knowledge lineage does not match the canonical adapter output.",
    );
  }
  return expectedKnowledgeLineage(write);
}

function assertStoredKnowledgePayload(
  existingDocument: KnowledgeDocument,
  existingChunks: readonly KnowledgeChunk[],
  requestedDocument: KnowledgeDocument,
  requestedChunks: readonly KnowledgeChunk[],
) {
  if (
    normalizeTenantId(existingDocument.tenantId) !==
      normalizeTenantId(requestedDocument.tenantId) ||
    existingDocument.id !== requestedDocument.id ||
    existingDocument.contentHash !== requestedDocument.contentHash ||
    existingDocument.chunkCount !== requestedDocument.chunkCount ||
    existingDocument.totalCharacters !== requestedDocument.totalCharacters ||
    existingDocument.title !== requestedDocument.title ||
    existingDocument.source !== requestedDocument.source ||
    existingDocument.sourceType !== requestedDocument.sourceType ||
    sourceContractSha256(existingDocument.tags) !==
      sourceContractSha256(requestedDocument.tags) ||
    sourceContractSha256(existingDocument.metadata) !==
      sourceContractSha256(requestedDocument.metadata) ||
    existingChunks.length !== requestedChunks.length
  ) {
    throw new Error(
      "Knowledge document idempotency key is already bound to different content.",
    );
  }
  const requestedByIndex = new Map(
    requestedChunks.map((chunk) => [chunk.chunkIndex, chunk]),
  );
  for (const existing of existingChunks) {
    const requested = requestedByIndex.get(existing.chunkIndex);
    if (
      !requested ||
      existing.id !== requested.id ||
      existing.content !== requested.content ||
      existing.characterCount !== requested.characterCount ||
      existing.title !== requested.title ||
      existing.source !== requested.source ||
      existing.tokenEstimate !== requested.tokenEstimate ||
      sourceContractSha256(existing.tags) !==
        sourceContractSha256(requested.tags) ||
      sourceContractSha256(existing.metadata) !==
        sourceContractSha256(requested.metadata)
    ) {
      throw new Error(
        "Knowledge document idempotency key is already bound to different chunks.",
      );
    }
  }
}

function assertStoredChunkLineage(
  existingChunks: readonly KnowledgeChunk[],
  requestedChunks: readonly KnowledgeChunk[],
  write: CanonicalTextSourceWrite,
) {
  const expectedRevisionId = write.adapterOutput.sourceRevision.sourceRevisionId;
  const requestedByIndex = new Map(
    requestedChunks.map((chunk) => [chunk.chunkIndex, chunk]),
  );
  for (const existing of existingChunks) {
    const requested = requestedByIndex.get(existing.chunkIndex);
    const expectedEvidenceId =
      write.evidenceUnitIdsByChunkIndex[existing.chunkIndex];
    if (
      !requested ||
      existing.sourceRevisionId !== expectedRevisionId ||
      existing.evidenceUnitId !== expectedEvidenceId ||
      requested.sourceRevisionId !== expectedRevisionId ||
      requested.evidenceUnitId !== expectedEvidenceId
    ) {
      throw new Error(
        "Stored knowledge chunks have incomplete or conflicting source lineage.",
      );
    }
  }
}

function expectedKnowledgeLineage(
  write: CanonicalTextSourceWrite,
): PersistedKnowledgeLineage {
  return {
    sourceItemId: write.adapterOutput.sourceItem.sourceItemId,
    sourceRevisionId: write.adapterOutput.sourceRevision.sourceRevisionId,
    evidenceUnitIdsByChunkIndex: write.evidenceUnitIdsByChunkIndex,
  };
}

function withoutChunkLineage(chunk: KnowledgeChunk): KnowledgeChunk {
  const {
    sourceRevisionId: _sourceRevisionId,
    evidenceUnitId: _evidenceUnitId,
    ...legacyChunk
  } = chunk;
  void _sourceRevisionId;
  void _evidenceUnitId;
  return legacyChunk;
}

async function readKnowledgeLedger() {
  return readJsonFile<KnowledgeLedger>(getKnowledgeFile(), { documents: [], chunks: [] });
}

function getKnowledgeFile() {
  return getDataPath("knowledge.json");
}

function cognitionContractId(value: string, label: string) {
  const normalized = String(value || "").trim();
  if (
    !normalized ||
    normalized.length > 320 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(normalized)
  ) {
    throw new Error(`Knowledge cognition ${label} identity is invalid.`);
  }
  return normalized;
}

type CognitionEligibility = Readonly<{
  tenantId: string;
  actorId: string;
  asOfTime: string;
}>;

function currentCognitionOutputs(
  ledger: KnowledgeLedger,
): SourceAdapterUpsertV1[] | null {
  const parsed: SourceAdapterUpsertV1[] = [];
  for (const candidate of ledger.sourceLineage?.adapterOutputs || []) {
    const result = sourceAdapterUpsertV1Schema.safeParse(candidate);
    if (!result.success) return null;
    parsed.push(result.data);
  }
  const settledSourceItems = new Set<string>();
  return parsed.filter((output) => {
    const sourceItemId = output.sourceItem.sourceItemId;
    if (settledSourceItems.has(sourceItemId)) return false;
    settledSourceItems.add(sourceItemId);
    return true;
  });
}

function cognitionOutputIsEligible(
  output: SourceAdapterUpsertV1,
  context: CognitionEligibility,
) {
  const bindings = [output, output.sourceItem, output.sourceRevision];
  if (
    bindings.some((binding) =>
      !cognitionBindingIsEligible(binding, context)
    ) ||
    output.sourceItem.capturedAt > context.asOfTime ||
    output.sourceRevision.capturedAt > context.asOfTime
  ) return false;
  return output.evidenceUnits.every((evidence) =>
    cognitionBindingIsEligible(evidence, context) &&
    evidence.sourceItemId === output.sourceItem.sourceItemId &&
    evidence.sourceRevisionId === output.sourceRevision.sourceRevisionId &&
    evidence.capturedAt <= context.asOfTime &&
    evidence.extractedAt <= context.asOfTime
  );
}

function cognitionBindingIsEligible(
  binding: Pick<
    SourceAdapterUpsertV1,
    | "tenantId"
    | "ownerActorId"
    | "visibility"
    | "allowedPurposeIds"
    | "retentionExpiresAt"
  >,
  context: CognitionEligibility,
) {
  return binding.tenantId === context.tenantId &&
    binding.ownerActorId === context.actorId &&
    binding.visibility === "user_private" &&
    binding.allowedPurposeIds.includes(KNOWLEDGE_COGNIFY_PURPOSE_ID) &&
    (
      binding.retentionExpiresAt === null ||
      binding.retentionExpiresAt > context.asOfTime
    );
}

function cognitionChunkMatchesEvidence(input: CognitionEligibility & {
  chunk: KnowledgeChunk;
  evidence: EvidenceUnitV1;
  sourceItemId: string;
  sourceRevisionId: string;
}) {
  const { chunk, evidence } = input;
  return normalizeTenantId(chunk.tenantId) === input.tenantId &&
    chunk.sourceRevisionId === input.sourceRevisionId &&
    chunk.evidenceUnitId === evidence.evidenceUnitId &&
    evidence.sourceItemId === input.sourceItemId &&
    evidence.sourceRevisionId === input.sourceRevisionId &&
    cognitionBindingIsEligible(evidence, input) &&
    evidence.capturedAt <= input.asOfTime &&
    evidence.extractedAt <= input.asOfTime &&
    evidence.evidenceContentSha256 === hashContent(chunk.content) &&
    evidence.evidenceByteLength === Buffer.byteLength(chunk.content, "utf8");
}

function cognitionDatabaseChunks(
  value: unknown,
  document: KnowledgeDocument,
  context: CognitionEligibility,
) {
  const sourceItemId = document.sourceItemId;
  const sourceRevisionId = document.sourceRevisionId;
  if (!sourceItemId || !sourceRevisionId || !Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) return [];
    const lineage = candidate as Record<string, unknown>;
    try {
      const chunk = chunkFromRow(storedRecord(lineage.chunk));
      const evidence = evidenceUnitFromStoredRow(storedRecord(lineage.evidence));
      return cognitionChunkMatchesEvidence({
          ...context,
          chunk,
          evidence,
          sourceItemId,
          sourceRevisionId,
        })
        ? [chunk]
        : [];
    } catch {
      return [];
    }
  });
}

function cognitionFileChunks(input: CognitionEligibility & {
  ledger: KnowledgeLedger;
  document: KnowledgeDocument;
  output: SourceAdapterUpsertV1;
}): KnowledgeChunk[] | null {
  const { document, output } = input;
  if (!document.sourceItemId || !document.sourceRevisionId) return null;
  const candidates = input.ledger.chunks
    .filter((chunk) =>
      normalizeTenantId(chunk.tenantId) === input.tenantId &&
      chunk.documentId === document.id
    )
    .sort((left, right) =>
      left.chunkIndex - right.chunkIndex || left.id.localeCompare(right.id)
    )
    .map(sanitizeKnowledgeChunk);
  if (
    candidates.length !== document.chunkCount ||
    output.evidenceUnits.length !== document.chunkCount ||
    document.chunkCount < 1
  ) return null;
  const evidenceById = new Map(output.evidenceUnits.map((evidence) =>
    [evidence.evidenceUnitId, evidence] as const
  ));
  const usedEvidence = new Set<string>();
  for (const [index, chunk] of candidates.entries()) {
    const evidence = chunk.evidenceUnitId
      ? evidenceById.get(chunk.evidenceUnitId)
      : undefined;
    if (
      chunk.chunkIndex !== index ||
      !evidence ||
      usedEvidence.has(evidence.evidenceUnitId) ||
      !cognitionChunkMatchesEvidence({
        ...input,
        chunk,
        evidence,
        sourceItemId: document.sourceItemId,
        sourceRevisionId: document.sourceRevisionId,
      })
    ) return null;
    usedEvidence.add(evidence.evidenceUnitId);
  }
  return usedEvidence.size === output.evidenceUnits.length
    ? candidates
    : null;
}

function buildReasons({
  overlap,
  vectorScore,
  lexicalScore,
  recencyScore,
}: {
  overlap: string[];
  vectorScore: number;
  lexicalScore: number;
  recencyScore: number;
}) {
  return [
    vectorScore > 0.2 ? "semantic match" : "",
    lexicalScore > 0 ? "keyword match" : "",
    overlap.length ? `matched ${overlap.slice(0, 5).join(", ")}` : "",
    recencyScore > 0.5 ? "recent source" : "",
  ].filter(Boolean);
}

function inferSourceType(source: string): KnowledgeSourceType {
  if (/^https?:\/\//i.test(source)) {
    return "url";
  }

  return "text";
}

function hashContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function storedRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored canonical evidence row is invalid.");
  }
  return value as Record<string, unknown>;
}

function orderCanonicalKnowledgeEvidence(
  candidates: readonly CanonicalKnowledgeEvidence[],
  chunkIds: readonly string[],
  tenantId: string,
) {
  const byChunkId = new Map<string, CanonicalKnowledgeEvidence>();
  for (const candidate of candidates) {
    const { chunk, evidenceUnit } = candidate;
    if (
      normalizeTenantId(chunk.tenantId) !== tenantId ||
      evidenceUnit.tenantId !== tenantId ||
      chunk.evidenceUnitId !== evidenceUnit.evidenceUnitId ||
      chunk.sourceRevisionId !== evidenceUnit.sourceRevisionId ||
      evidenceUnit.evidenceContentSha256 !== hashContent(chunk.content) ||
      evidenceUnit.evidenceByteLength !== Buffer.byteLength(chunk.content, "utf8")
    ) {
      throw new Error(
        "Canonical knowledge evidence does not match its tenant-scoped chunk.",
      );
    }
    if (byChunkId.has(chunk.id)) {
      throw new Error("Canonical knowledge evidence resolved a duplicate chunk.");
    }
    byChunkId.set(chunk.id, candidate);
  }
  return chunkIds.flatMap((chunkId) => {
    const candidate = byChunkId.get(chunkId);
    return candidate ? [candidate] : [];
  });
}

function canonicalSourceState(input: {
  currentRevisionId: unknown;
  operation: unknown;
  sourceRevisionId: unknown;
}): CanonicalKnowledgeEvidence["sourceState"] {
  const currentRevisionId = typeof input.currentRevisionId === "string"
    ? input.currentRevisionId
    : null;
  const operation = input.operation === "delete" ? "delete" : "upsert";
  return Object.freeze({
    currentRevisionId,
    operation,
    isCurrent:
      operation === "upsert" &&
      currentRevisionId !== null &&
      currentRevisionId === input.sourceRevisionId,
  });
}

function estimateTokens(content: string) {
  return Math.ceil(content.length / 4);
}

function normalizeTags(tags: string[]) {
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 16),
    ),
  );
}

function hasTagFilter(options: SearchKnowledgeOptions) {
  return normalizeTags(options.tags || []).length > 0;
}

function filterKnowledgeResultsByTags(results: KnowledgeSearchResult[], tags?: string[]) {
  const requiredTags = normalizeTags(tags || []);
  if (!requiredTags.length) {
    return results;
  }

  return results.filter((result) => requiredTags.every((tag) => result.chunk.tags.includes(tag)));
}

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
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

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function optionalString(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}
