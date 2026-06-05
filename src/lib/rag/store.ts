import { createHash, randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
import { cosineSimilarity, parseEmbedding, toVectorLiteral } from "@/lib/rag/vector";
import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeLedger,
  KnowledgeSearchResult,
  KnowledgeSourceType,
} from "@/lib/rag/types";

type CreateKnowledgeDocumentInput = {
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
};

export async function createKnowledgeDocument(input: CreateKnowledgeDocumentInput) {
  const now = new Date().toISOString();
  const tags = normalizeTags(["rag", ...(input.tags || [])]);
  const source = input.source?.trim() || "manual";
  const document: KnowledgeDocument = {
    id: randomUUID(),
    title: input.title.trim(),
    source,
    sourceType: input.sourceType || inferSourceType(source),
    tags,
    contentHash: hashContent(input.content),
    chunkCount: input.chunks.length,
    totalCharacters: input.content.length,
    metadata: input.metadata || {},
    createdAt: now,
    updatedAt: now,
  };
  const chunks: KnowledgeChunk[] = input.chunks.map((chunk) => ({
    id: randomUUID(),
    documentId: document.id,
    chunkIndex: chunk.index,
    title: input.chunks.length > 1 ? `${document.title} (${chunk.index + 1}/${input.chunks.length})` : document.title,
    content: chunk.content,
    tags,
    source,
    tokenEstimate: estimateTokens(chunk.content),
    characterCount: chunk.content.length,
    embedding: chunk.embedding,
    metadata: { documentTitle: document.title },
    createdAt: now,
    updatedAt: now,
  }));

  if (hasDatabaseUrl()) {
    await insertKnowledgeDocumentDb(document, chunks);
    return { document, chunks };
  }

  const ledger = await readKnowledgeLedger();
  ledger.documents.unshift(document);
  ledger.chunks.unshift(...chunks);
  await writeKnowledgeLedger(ledger);
  return { document, chunks };
}

export async function listKnowledgeDocuments(limit = 20) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_knowledge_documents
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(documentFromRow);
  }

  const ledger = await readKnowledgeLedger();
  return ledger.documents.slice(0, limit);
}

export async function listKnowledgeChunks(limit = 20) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_knowledge_chunks
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(chunkFromRow);
  }

  const ledger = await readKnowledgeLedger();
  return ledger.chunks.slice(0, limit);
}

export async function searchKnowledge(
  query: string,
  options: SearchKnowledgeOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const limit = options.limit || 8;

  if (hasDatabaseUrl()) {
    const dbResults = await searchKnowledgeDb(query, options);
    if (dbResults.length) {
      return dbResults.slice(0, limit);
    }
  }

  const ledger = await readKnowledgeLedger();
  const documentsById = new Map(ledger.documents.map((document) => [document.id, document]));
  return rankChunksInMemory(ledger.chunks, documentsById, query, options).slice(0, limit);
}

export async function getKnowledgeStats() {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT COUNT(*)::int AS documents,
             COALESCE(SUM(chunk_count), 0)::int AS chunks,
             COALESCE(SUM(total_characters), 0)::int AS characters
      FROM omni_knowledge_documents
    `;
    const embeddedRows = await getSql()`
      SELECT COUNT(*)::int AS count
      FROM omni_knowledge_chunks
      WHERE jsonb_typeof(embedding) = 'array'
    `;

    return {
      documents: Number(rows[0]?.documents || 0),
      chunks: Number(rows[0]?.chunks || 0),
      characters: Number(rows[0]?.characters || 0),
      embedded: Number(embeddedRows[0]?.count || 0),
    };
  }

  const ledger = await readKnowledgeLedger();
  return {
    documents: ledger.documents.length,
    chunks: ledger.chunks.length,
    characters: ledger.documents.reduce((sum, document) => sum + document.totalCharacters, 0),
    embedded: ledger.chunks.filter((chunk) => chunk.embedding?.length).length,
  };
}

async function insertKnowledgeDocumentDb(document: KnowledgeDocument, chunks: KnowledgeChunk[]) {
  await ensureDatabaseSchema();
  const sql = getSql();

  await sql`
    INSERT INTO omni_knowledge_documents (
      id, title, source, source_type, tags, content_hash, chunk_count, total_characters, metadata, created_at, updated_at
    )
    VALUES (
      ${document.id}, ${document.title}, ${document.source}, ${document.sourceType}, ${document.tags},
      ${document.contentHash}, ${document.chunkCount}, ${document.totalCharacters}, ${JSON.stringify(document.metadata)}::jsonb,
      ${document.createdAt}, ${document.updatedAt}
    )
  `;

  for (const chunk of chunks) {
    const embeddingJson = chunk.embedding ? JSON.stringify(chunk.embedding) : null;
    await sql`
      INSERT INTO omni_knowledge_chunks (
        id, document_id, chunk_index, title, content, tags, source, token_estimate,
        character_count, embedding, metadata, created_at, updated_at
      )
      VALUES (
        ${chunk.id}, ${chunk.documentId}, ${chunk.chunkIndex}, ${chunk.title}, ${chunk.content}, ${chunk.tags},
        ${chunk.source}, ${chunk.tokenEstimate}, ${chunk.characterCount}, ${embeddingJson}::jsonb,
        ${JSON.stringify(chunk.metadata)}::jsonb, ${chunk.createdAt}, ${chunk.updatedAt}
      )
    `;
    await updateChunkVector(chunk.id, chunk.embedding);
  }
}

async function updateChunkVector(chunkId: string, embedding?: number[]) {
  const vector = toVectorLiteral(embedding);
  if (!vector) {
    return;
  }

  try {
    await getSql()`
      UPDATE omni_knowledge_chunks
      SET embedding_vector = ${vector}::vector
      WHERE id = ${chunkId}
    `;
  } catch {
    // pgvector is optional; JSON embeddings still support application-side similarity.
  }
}

async function searchKnowledgeDb(
  query: string,
  options: SearchKnowledgeOptions,
): Promise<KnowledgeSearchResult[]> {
  await ensureDatabaseSchema();
  const limit = options.limit || 8;
  const queryText = query.trim();
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
        WHERE c.embedding_vector IS NOT NULL
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
        LIMIT ${limit}
      `;
      return rows.map(knowledgeResultFromRow);
    } catch {
      return searchKnowledgeLexicalDb(queryText, limit);
    }
  }

  return searchKnowledgeLexicalDb(queryText, limit);
}

async function searchKnowledgeLexicalDb(query: string, limit: number) {
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
    WHERE ${query} = ''
       OR to_tsvector('english', c.title || ' ' || c.content) @@ plainto_tsquery('english', ${query})
    ORDER BY lexical_score DESC, c.updated_at DESC
    LIMIT ${limit}
  `;
  return rows.map(knowledgeResultFromRow);
}

function rankChunksInMemory(
  chunks: KnowledgeChunk[],
  documentsById: Map<string, KnowledgeDocument>,
  query: string,
  options: SearchKnowledgeOptions,
) {
  const terms = tokenize(query);
  const now = Date.now();

  return chunks
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
  return {
    id: String(row.id),
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
  };
}

function chunkFromRow(row: Record<string, unknown>): KnowledgeChunk {
  return {
    id: String(row.id),
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
  };
}

async function readKnowledgeLedger() {
  return readJsonFile<KnowledgeLedger>(getKnowledgeFile(), { documents: [], chunks: [] });
}

async function writeKnowledgeLedger(ledger: KnowledgeLedger) {
  await writeJsonFile(getKnowledgeFile(), {
    documents: ledger.documents.slice(0, 100),
    chunks: ledger.chunks.slice(0, 1200),
  });
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
