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
import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeLedger,
  KnowledgeSearchResult,
  KnowledgeSourceType,
} from "@/lib/rag/types";
import type { MemoryRecord } from "@/lib/memory/types";

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
};

type SearchKnowledgeOptions = {
  limit?: number;
  queryEmbedding?: number[];
  tags?: string[];
  tenantId?: string;
};

export async function createKnowledgeDocument(input: CreateKnowledgeDocumentInput) {
  const now = new Date().toISOString();
  const safeTitle = String(redactSensitive(input.title.trim())).slice(0, 240);
  const safeContent = String(redactSensitive(input.content)).slice(0, 900_000);
  const tags = normalizeTags(
    ["rag", ...(input.tags || [])].map((tag) =>
      String(redactSensitive(tag)),
    ),
  );
  const source =
    String(redactSensitive(input.source?.trim() || "manual")).slice(0, 2_000);
  const tenantId = normalizeTenantId(input.tenantId);
  const documentId = input.idempotencyKey
    ? knowledgeDocumentId(tenantId, input.idempotencyKey)
    : randomUUID();
  const document: KnowledgeDocument = {
    id: documentId,
    tenantId,
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
    const safeChunkContent = String(redactSensitive(chunk.content));
    return {
      id: input.idempotencyKey
        ? `${documentId}_chunk_${chunk.index}`
        : randomUUID(),
      tenantId,
      documentId: document.id,
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

  if (hasDatabaseUrl()) {
    await insertKnowledgeDocumentDb(document, chunks);
    return { document, chunks };
  }

  await updateJsonFile<KnowledgeLedger>(
    getKnowledgeFile(),
    { documents: [], chunks: [] },
    (ledger) => ({
      documents: ledger.documents.some((item) => item.id === document.id)
        ? ledger.documents
        : [document, ...ledger.documents].slice(0, 100),
      chunks: [
        ...chunks.filter(
          (chunk) => !ledger.chunks.some((item) => item.id === chunk.id),
        ),
        ...ledger.chunks,
      ].slice(0, 1200),
    }),
  );
  return { document, chunks };
}

export async function deleteKnowledgeDocumentByIdempotencyKey(idempotencyKey: string, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const documentId = knowledgeDocumentId(tenantId, idempotencyKey);
  const forgottenAt = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql().transaction(async (sql: RagSqlClient) => {
      await sql`DELETE FROM omni_knowledge_chunks WHERE tenant_id = ${tenantId} AND document_id = ${documentId}`;
      await sql`DELETE FROM omni_knowledge_documents WHERE tenant_id = ${tenantId} AND id = ${documentId}`;
      await sql`UPDATE omni_memories SET title = '[forgotten]', content = '', tags = '{}', source = '[forgotten]', embedding = NULL, claim_status = 'forgotten', forgotten_at = ${forgottenAt}, updated_at = ${forgottenAt} WHERE tenant_id = ${tenantId} AND id LIKE ${documentId + "_memory_%"}`;
    });
    return documentId;
  }
  await updateJsonFile<KnowledgeLedger>(getKnowledgeFile(), { documents: [], chunks: [] }, (ledger) => ({
    documents: ledger.documents.filter((document) => document.id !== documentId || normalizeTenantId(document.tenantId) !== tenantId),
    chunks: ledger.chunks.filter((chunk) => chunk.documentId !== documentId || normalizeTenantId(chunk.tenantId) !== tenantId),
  }));
  await updateJsonFile<MemoryRecord[]>(getDataPath("memory.json"), [], (memories) => memories.map((memory) =>
    normalizeTenantId(memory.tenantId) === tenantId && memory.id.startsWith(`${documentId}_memory_`)
      ? { ...memory, title: "[forgotten]", content: "", tags: [], source: "[forgotten]", embedding: undefined, claimStatus: "forgotten", forgottenAt, updatedAt: forgottenAt }
      : memory,
  ));
  return documentId;
}

export async function deleteKnowledgeDocumentsBySourcePrefix(sourcePrefix: string, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const prefix = String(redactSensitive(sourcePrefix)).trim().slice(0, 500);
  if (!prefix) throw new Error("A source prefix is required.");
  const forgottenAt = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: RagSqlClient) => {
      const rows = await sql`SELECT id FROM omni_knowledge_documents WHERE tenant_id = ${tenantId} AND source LIKE ${prefix + "%"}`;
      const ids = rows.map((row) => String(row.id));
      if (!ids.length) return { documents: 0, memories: 0 };
      const forgotten = await sql`UPDATE omni_memories SET title = '[forgotten]', content = '', tags = '{}', source = '[forgotten]', embedding = NULL, embedding_vector = NULL, claim_status = 'forgotten', forgotten_at = ${forgottenAt}, updated_at = ${forgottenAt} WHERE tenant_id = ${tenantId} AND source LIKE ${prefix + "%"} RETURNING id`;
      await sql`DELETE FROM omni_knowledge_documents WHERE tenant_id = ${tenantId} AND id = ANY(${ids})`;
      return { documents: ids.length, memories: forgotten.length };
    });
  }
  const ledger = await readKnowledgeLedger();
  const ids = new Set(ledger.documents.filter((document) => normalizeTenantId(document.tenantId) === tenantId && document.source.startsWith(prefix)).map((document) => document.id));
  await updateJsonFile<KnowledgeLedger>(getKnowledgeFile(), { documents: [], chunks: [] }, (current) => ({
    documents: current.documents.filter((document) => !ids.has(document.id)),
    chunks: current.chunks.filter((chunk) => !ids.has(chunk.documentId)),
  }));
  let memories = 0;
  await updateJsonFile<MemoryRecord[]>(getDataPath("memory.json"), [], (items) => items.map((memory) => {
    if (normalizeTenantId(memory.tenantId) !== tenantId || !memory.source.startsWith(prefix)) return memory;
    memories += 1;
    return { ...memory, title: "[forgotten]", content: "", tags: [], source: "[forgotten]", embedding: undefined, claimStatus: "forgotten", forgottenAt, updatedAt: forgottenAt };
  }));
  return { documents: ids.size, memories };
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

async function insertKnowledgeDocumentDb(document: KnowledgeDocument, chunks: KnowledgeChunk[]) {
  await ensureDatabaseSchema();
  const sql = getSql();
  const chunkPayload = chunks.map((chunk) => ({
    id: chunk.id,
    tenant_id: chunk.tenantId,
    document_id: chunk.documentId,
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
  await sql.transaction(async (transaction: RagSqlClient) => {
    await transaction`
      INSERT INTO omni_knowledge_documents (
        id, tenant_id, title, source, source_type, tags, content_hash, chunk_count, total_characters, metadata, created_at, updated_at
      )
      VALUES (
        ${document.id}, ${document.tenantId}, ${document.title}, ${document.source}, ${document.sourceType}, ${document.tags},
        ${document.contentHash}, ${document.chunkCount}, ${document.totalCharacters}, ${document.metadata}::jsonb,
        ${document.createdAt}, ${document.updatedAt}
      )
      ON CONFLICT (id) DO NOTHING
    `;

    if (chunkPayload.length) {
      await transaction`
        INSERT INTO omni_knowledge_chunks (
          id, tenant_id, document_id, chunk_index, title, content, tags, source, token_estimate,
          character_count, embedding, metadata, created_at, updated_at
        )
        SELECT
          id, tenant_id, document_id, chunk_index, title, content, tags, source,
          token_estimate, character_count, embedding, metadata, created_at,
          updated_at
        FROM jsonb_to_recordset(${chunkPayload}::jsonb) AS input(
          id text,
          tenant_id text,
          document_id text,
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
      `;
    }
  });
  const vectors = chunks
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

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}
