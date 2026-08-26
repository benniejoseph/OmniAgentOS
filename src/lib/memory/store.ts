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
};

type TenantScopedOptions = {
  tenantId?: string;
  limit?: number;
  includeInactive?: boolean;
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
    const rows = options.includeInactive
      ? await sql`SELECT * FROM omni_memories WHERE tenant_id = ${tenantId} AND claim_status <> 'forgotten' ORDER BY updated_at DESC LIMIT ${limit}`
      : await sql`SELECT * FROM omni_memories WHERE tenant_id = ${tenantId} AND claim_status = 'active' AND (valid_from IS NULL OR valid_from <= NOW()) AND (valid_to IS NULL OR valid_to > NOW()) ORDER BY updated_at DESC LIMIT ${limit}`;
    return rows.map(memoryFromRow);
  }

  const memories = await readJsonFile<MemoryRecord[]>(getMemoryFile(), []);
  return memories
    .filter((memory) => normalizeTenantId(memory.tenantId) === tenantId)
    .filter((memory) => sanitizeMemoryRecord(memory).claimStatus !== "forgotten")
    .filter((memory) => options.includeInactive || isActiveMemory(sanitizeMemoryRecord(memory)))
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
      confidence: record.confidence,
      claim_status: record.claimStatus,
      asserted_by: record.assertedBy,
      evidence_refs: record.evidenceRefs,
      valid_from: record.validFrom || null,
      valid_to: record.validTo || null,
      supersedes_id: record.supersedesId || null,
      contradiction_of_id: record.contradictionOfId || null,
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
          confidence double precision,
          claim_status text,
          asserted_by text,
          evidence_refs text[],
          valid_from timestamptz,
          valid_to timestamptz,
          supersedes_id text,
          contradiction_of_id text,
          embedding jsonb,
          created_at timestamptz,
          updated_at timestamptz
        )
      ),
      inserted AS (
        INSERT INTO omni_memories (
          id, tenant_id, type, title, content, tags, scope, source, importance,
          confidence, claim_status, asserted_by, evidence_refs, valid_from, valid_to,
          supersedes_id, contradiction_of_id, embedding, created_at, updated_at
        )
        SELECT
          id, tenant_id, type, title, content, tags, scope, source, importance,
          confidence, claim_status, asserted_by, evidence_refs, valid_from, valid_to,
          supersedes_id, contradiction_of_id, embedding, created_at, updated_at
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

export async function getMemory(id: string, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM omni_memories WHERE id = ${id} AND tenant_id = ${tenantId} LIMIT 1`;
    return rows[0] ? memoryFromRow(rows[0]) : null;
  }
  const memories = await readJsonFile<MemoryRecord[]>(getMemoryFile(), []);
  const memory = memories.find((item) => item.id === id && normalizeTenantId(item.tenantId) === tenantId);
  return memory ? sanitizeMemoryRecord(memory) : null;
}

export async function correctMemory(
  id: string,
  correction: { title?: string; content?: string; confidence?: number; validTo?: string; contradiction?: boolean; embedding?: number[] },
  options: { tenantId?: string; actorId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const existing = await getMemory(id, { tenantId });
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
  });
  const oldStatus: NonNullable<MemoryRecord["claimStatus"]> = correction.contradiction ? "contradicted" : "superseded";
  if (hasDatabaseUrl()) {
    await getSql()`UPDATE omni_memories SET claim_status = ${oldStatus}, valid_to = COALESCE(valid_to, NOW()), updated_at = NOW() WHERE id = ${id} AND tenant_id = ${tenantId} AND claim_status <> 'forgotten'`;
  } else {
    await updateJsonFile<MemoryRecord[]>(getMemoryFile(), [], (memories) => memories.map((memory) =>
      memory.id === id && normalizeTenantId(memory.tenantId) === tenantId
        ? { ...sanitizeMemoryRecord(memory), claimStatus: oldStatus, validTo: memory.validTo || new Date().toISOString(), updatedAt: new Date().toISOString() }
        : memory,
    ));
  }
  return { previous: { ...existing, claimStatus: oldStatus }, corrected };
}

export async function forgetMemory(id: string, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const forgottenAt = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`UPDATE omni_memories SET title = '[forgotten]', content = '', tags = '{}', source = '[forgotten]', embedding = NULL, embedding_vector = NULL, claim_status = 'forgotten', forgotten_at = ${forgottenAt}, updated_at = ${forgottenAt} WHERE id = ${id} AND tenant_id = ${tenantId} RETURNING *`;
    return rows[0] ? memoryFromRow(rows[0]) : null;
  }
  let forgotten: MemoryRecord | null = null;
  await updateJsonFile<MemoryRecord[]>(getMemoryFile(), [], (memories) => memories.map((memory) => {
    if (memory.id !== id || normalizeTenantId(memory.tenantId) !== tenantId) return memory;
    forgotten = { ...sanitizeMemoryRecord(memory), title: "[forgotten]", content: "", tags: [], source: "[forgotten]", embedding: undefined, claimStatus: "forgotten", forgottenAt, updatedAt: forgottenAt };
    return forgotten;
  }));
  return forgotten;
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
    ORDER BY (lexical_score * (0.35 + confidence * 0.65)) DESC, importance DESC, updated_at DESC
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
  });
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
  const now = Date.now();
  const validFrom = memory.validFrom ? Date.parse(memory.validFrom) : undefined;
  const validTo = memory.validTo ? Date.parse(memory.validTo) : undefined;
  return !(validFrom && validFrom > now) && !(validTo && validTo <= now);
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
