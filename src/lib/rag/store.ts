import { createHash, randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { getDataPath } from "@/lib/storage/paths";
import { redactSensitive } from "@/lib/security/context";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { cosineSimilarity, parseEmbedding, toVectorLiteral } from "@/lib/rag/vector";
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
  sourceAdapterUpsertV1Schema,
  sourceContractSha256,
} from "@/lib/sources/contracts";
import {
  assertCanonicalAdapterOutputReceipt,
  mergeCanonicalSourceLedger,
  persistCanonicalSourceWrite,
  storedAdapterEnvelopeMatches,
  type PersistedKnowledgeLineage,
} from "@/lib/sources/store";
import type { CanonicalTextSourceWrite } from "@/lib/sources/text-lineage";

type RagSqlClient = ReturnType<typeof getSql>;

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
  }>;
  metadata?: Record<string, unknown>;
  canonicalSourceWrite?: CanonicalTextSourceWrite;
};

type SearchKnowledgeOptions = {
  limit?: number;
  queryEmbedding?: number[];
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
        input.chunks.length > 1
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

export async function deleteKnowledgeDocumentsBySourcePrefix(sourcePrefix: string, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const prefix = String(redactSensitive(sourcePrefix)).trim().slice(0, 500);
  if (!prefix) throw new Error("A source prefix is required.");
  const retiredAt = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: RagSqlClient) => {
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
      await invalidateKnowledgeMemoryLineage(sql, tenantId, memoryIds);
      if (ids.length) {
        await sql`DELETE FROM omni_knowledge_documents WHERE tenant_id = ${tenantId} AND id = ANY(${ids})`;
      }
      const retired = await retireKnowledgeMemoryRows(
        sql,
        tenantId,
        memoryIds,
        retiredAt,
      );
      return { documents: ids.length, memories: retired.length };
    });
  }
  const ledger = await readKnowledgeLedger();
  const ids = new Set(ledger.documents.filter((document) => normalizeTenantId(document.tenantId) === tenantId && document.source.startsWith(prefix)).map((document) => document.id));
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
  return { documents: ids.size, memories };
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
) {
  if (!memoryIds.length) return;
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

export async function searchKnowledge(
  query: string,
  options: SearchKnowledgeOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const limit = options.limit || 8;

  if (hasDatabaseUrl()) {
    return (await searchKnowledgeDb(query, options)).slice(0, limit);
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
             COALESCE(SUM(total_characters), 0)::int AS characters
      FROM omni_knowledge_documents
      WHERE tenant_id = ${tenantId}
    `;
    const embeddedRows = await getSql()`
      SELECT COUNT(*)::int AS count
      FROM omni_knowledge_chunks
      WHERE jsonb_typeof(embedding) = 'array'
        AND tenant_id = ${tenantId}
    `;

    return {
      documents: Number(rows[0]?.documents || 0),
      chunks: Number(rows[0]?.chunks || 0),
      characters: Number(rows[0]?.characters || 0),
      embedded: Number(embeddedRows[0]?.count || 0),
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

async function insertKnowledgeDocumentDb(
  document: KnowledgeDocument,
  chunks: KnowledgeChunk[],
  canonicalSourceWrite?: CanonicalTextSourceWrite,
) {
  await ensureDatabaseSchema();
  const sql = getSql();
  const persistence = await sql.transaction(async (transaction: RagSqlClient) => {
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
        FROM jsonb_to_recordset(${JSON.stringify(chunkPayload)}::jsonb) AS input(
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
    return undefined;
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
        options.queryEmbedding && chunk.embedding
          ? Math.max(0, cosineSimilarity(options.queryEmbedding, chunk.embedding))
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
    if (
      locator.kind !== "text_span" ||
      locator.offsetUnit !== "utf16_code_unit" ||
      locator.containerLength !== normalizedContent.length ||
      locator.containerSha256 !== containerSha256 ||
      normalizedContent.slice(
        locator.startOffset,
        locator.endOffsetExclusive,
      ) !== chunk.content
    ) {
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
  if (!hasSourceItem && !hasSourceRevision) return undefined;
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
