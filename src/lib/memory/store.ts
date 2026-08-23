import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { getDataPath } from "@/lib/storage/paths";
import { redactSensitive } from "@/lib/security/context";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import type { MemoryRecord, MemorySearchResult, MemoryType } from "@/lib/memory/types";
import { cosineSimilarity, parseEmbedding, toVectorLiteral } from "@/lib/rag/vector";

type CreateMemoryInput = {
  id?: string;
  tenantId?: string;
  type?: MemoryType;
  title: string;
  content: string;
  tags?: string[];
  scope?: MemoryRecord["scope"];
  source?: string;
  importance?: number;
  embedding?: number[];
};

type TenantScopedOptions = {
  tenantId?: string;
  limit?: number;
  sql?: MemorySqlClient;
};

type MemorySqlClient = {
  (
    strings: TemplateStringsArray,
    ...params: unknown[]
  ): Promise<Record<string, unknown>[]>;
};

export async function listMemories(options: TenantScopedOptions = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const limit = options.limit || 500;

  if (hasDatabaseUrl()) {
    if (!options.sql) {
      await ensureDatabaseSchema();
    }
    const sql = options.sql || getSql();
    const rows = await sql`
      SELECT *
      FROM omni_memories
      WHERE tenant_id = ${tenantId}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(memoryFromRow);
  }

  const memories = await readJsonFile<MemoryRecord[]>(getMemoryFile(), []);
  return memories
    .filter((memory) => normalizeTenantId(memory.tenantId) === tenantId)
    .slice(0, limit)
    .map(sanitizeMemoryRecord);
}

function memoryRecordFromInput(
  input: CreateMemoryInput,
  now: string,
): MemoryRecord {
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
    tenantId: normalizeTenantId(input.tenantId),
    type: input.type || "fact",
    title,
    content,
    tags,
    scope: input.scope || "workspace",
    source,
    importance: input.importance ?? 0.5,
    createdAt: now,
    updatedAt: now,
    embedding: textWasRedacted ? undefined : input.embedding,
  };
}

export async function saveMemory(input: CreateMemoryInput) {
  return (await saveMemories([input]))[0];
}

export async function saveMemories(inputs: CreateMemoryInput[]) {
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
      embedding: record.embedding || null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }));
    const rows = await getSql()`
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
          embedding jsonb,
          created_at timestamptz,
          updated_at timestamptz
        )
      ),
      inserted AS (
        INSERT INTO omni_memories (
          id, tenant_id, type, title, content, tags, scope, source, importance,
          embedding, created_at, updated_at
        )
        SELECT
          id, tenant_id, type, title, content, tags, scope, source, importance,
          embedding, created_at, updated_at
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
    if (rows.length !== records.length) {
      throw new Error("Memory idempotency key collided with another tenant.");
    }
    const byId = new Map(
      rows.map((row) => [String(row.id), memoryFromRow(row)]),
    );
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
    if (insertedVectors.length) {
      try {
        await getSql()`
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
    return records.map((record) => {
      const saved = byId.get(record.id);
      if (!saved) {
        throw new Error("Bulk memory persistence did not return a saved row.");
      }
      return saved;
    });
  }

  const savedById = new Map<string, MemoryRecord>();
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
        savedById.set(record.id, existing);
        continue;
      }
      next.unshift(record);
      savedById.set(record.id, record);
    }
    return next;
  });
  return records.map((record) => savedById.get(record.id) as MemoryRecord);
}

export async function searchMemories(
  query: string,
  options: { limit?: number; queryEmbedding?: number[]; tenantId?: string } = {},
): Promise<MemorySearchResult[]> {
  if (hasDatabaseUrl()) {
    const results = await searchMemoriesDb(query, options);
    if (results.length) {
      return results;
    }
  }

  const memories = await listMemories({ tenantId: options.tenantId });
  const terms = tokenize(query);
  const limit = options.limit || 8;

  return memories
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
      const score = lexicalScore + tagScore + importanceScore + embeddingScore;
      const reasons = [
        overlap.length ? `matched ${overlap.slice(0, 5).join(", ")}` : "",
        embeddingScore ? "semantic match" : "",
        record.importance >= 0.8 ? "high importance" : "",
      ].filter(Boolean);

      return { record, score, reasons };
    })
    .filter((result) => result.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
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
          AND embedding_vector IS NOT NULL
        ORDER BY (
          (0.58 * GREATEST(0, 1 - (embedding_vector <=> ${vector}::vector))) +
          (0.24 * CASE
            WHEN ${queryText} = '' THEN 0
            ELSE ts_rank_cd(
              to_tsvector('english', title || ' ' || content),
              plainto_tsquery('english', ${queryText})
            )
          END) +
          (0.12 * importance) +
          (0.06 * (1 / (1 + EXTRACT(EPOCH FROM (NOW() - updated_at)) / 604800)))
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
      AND (
        ${query} = ''
        OR to_tsvector('english', title || ' ' || content) @@ plainto_tsquery('english', ${query})
      )
    ORDER BY lexical_score DESC, importance DESC, updated_at DESC
    LIMIT ${limit}
  `;

  return rows.map(memorySearchResultFromRow);
}

function memoryFromRow(row: Record<string, unknown>): MemoryRecord {
  return sanitizeMemoryRecord({
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
    type: String(row.type) as MemoryType,
    title: String(row.title || ""),
    content: String(row.content || ""),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    scope: String(row.scope || "workspace") as MemoryRecord["scope"],
    source: String(row.source || "database"),
    importance: Number(row.importance || 0.5),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
    embedding: parseEmbedding(row.embedding),
  });
}

function sanitizeMemoryRecord(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    title: String(redactSensitive(record.title)).slice(0, 240),
    content: String(redactSensitive(record.content)).slice(0, 200_000),
    tags: normalizeTags(
      record.tags.map((tag) => String(redactSensitive(tag))),
    ),
    source: String(redactSensitive(record.source)).slice(0, 2_000),
  };
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
  const score = vectorScore * 0.58 + lexicalScore * 0.24 + memory.importance * 0.12 + recencyScore * 0.06;

  return {
    record: memory,
    score,
    reasons: [
      vectorScore > 0.2 ? "semantic match" : "",
      lexicalScore > 0 ? "keyword match" : "",
      memory.importance >= 0.8 ? "high importance" : "",
      recencyScore > 0.5 ? "recent memory" : "",
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
