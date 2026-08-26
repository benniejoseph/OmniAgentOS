import {
  PGVECTOR_HNSW_MAX_DIMENSIONS,
  VECTOR_INDEX_DIMENSIONS,
} from "@/lib/config";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { getMemoryStats } from "@/lib/memory/store";
import { AsyncTtlCache } from "@/lib/performance/async-ttl-cache";
import { getKnowledgeStats } from "@/lib/rag/store";

const defaultReadTimeoutMs = 1_250;
const defaultStatementTimeoutMs = 5_000;

type SettingsStorageSource = "postgres" | "local";
type SettingsStorageFailureReason = "timeout" | "error";

export type ReadySettingsStorageSnapshot = {
  vectorStore: {
    configured: boolean;
    extensionInstalled?: boolean;
    extensionVersion?: string;
    dimensions: number;
    hnswSupported: boolean;
    memoryColumnDimensions?: number;
    knowledgeColumnDimensions?: number;
    memoryIndexed?: boolean;
    knowledgeIndexed?: boolean;
    status: "ready" | "degraded" | "not_configured";
  };
  memory: {
    total: number;
    byType: Record<string, number>;
    embedded: number;
    status: "ready";
  };
  knowledge: {
    documents: number;
    chunks: number;
    characters: number;
    embedded: number;
    status: "ready";
  };
};

export type SettingsStorageSnapshot =
  | (ReadySettingsStorageSnapshot & {
      storageSnapshot: {
        status: "ready";
        source: SettingsStorageSource;
        checkedAt: string;
      };
    })
  | {
      vectorStore: {
        configured: null;
        extensionInstalled: null;
        dimensions: number;
        hnswSupported: boolean;
        memoryColumnDimensions: null;
        knowledgeColumnDimensions: null;
        memoryIndexed: null;
        knowledgeIndexed: null;
        status: "unavailable";
        unavailableReason: SettingsStorageFailureReason;
      };
      memory: {
        total: null;
        byType: null;
        embedded: null;
        status: "unavailable";
        unavailableReason: SettingsStorageFailureReason;
      };
      knowledge: {
        documents: null;
        chunks: null;
        characters: null;
        embedded: null;
        status: "unavailable";
        unavailableReason: SettingsStorageFailureReason;
      };
      storageSnapshot: {
        status: "degraded";
        source: SettingsStorageSource;
        reason: SettingsStorageFailureReason;
        checkedAt: string;
      };
    };

type SettingsSnapshotOptions = {
  timeoutMs?: number;
  loader?: (
    tenantId: string,
  ) => Promise<
    ReadySettingsStorageSnapshot | ReadySettingsStorageSnapshotResult
  >;
};

export type ReadySettingsStorageSnapshotResult = {
  checkedAt: string;
  snapshot: ReadySettingsStorageSnapshot;
};

const readySnapshotCache =
  new AsyncTtlCache<ReadySettingsStorageSnapshotResult>(15_000, 64);

class SettingsSnapshotTimeoutError extends Error {
  constructor() {
    super("Settings storage snapshot timed out.");
    this.name = "SettingsSnapshotTimeoutError";
  }
}

export async function loadSettingsStorageSnapshot(
  tenantId: string,
  options: SettingsSnapshotOptions = {},
): Promise<SettingsStorageSnapshot> {
  const source: SettingsStorageSource = hasDatabaseUrl() ? "postgres" : "local";
  const timeoutMs = normalizeTimeoutMs(
    options.timeoutMs ?? configuredReadTimeoutMs(),
  );
  const startedAt = performance.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const cached = await Promise.race([
      readySnapshotCache.get(tenantId, async () => {
        const loaded = await (options.loader || readSettingsStorageSnapshot)(
          tenantId,
        );
        if (isReadySnapshotResult(loaded)) {
          return loaded;
        }
        return {
          checkedAt: new Date().toISOString(),
          snapshot: loaded,
        };
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new SettingsSnapshotTimeoutError()),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
    return {
      ...cached.snapshot,
      storageSnapshot: {
        status: "ready",
        source,
        checkedAt: cached.checkedAt,
      },
    };
  } catch (error) {
    const reason: SettingsStorageFailureReason =
      error instanceof SettingsSnapshotTimeoutError ? "timeout" : "error";
    console.warn(JSON.stringify({
      level: "warn",
      event: "capabilities.settings_storage_degraded",
      reason,
      source,
      durationMs: Math.round(performance.now() - startedAt),
    }));
    return unavailableSettingsStorageSnapshot(source, reason);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function isReadySnapshotResult(
  value: ReadySettingsStorageSnapshot | ReadySettingsStorageSnapshotResult,
): value is ReadySettingsStorageSnapshotResult {
  return (
    "snapshot" in value &&
    typeof value.checkedAt === "string" &&
    value.checkedAt.trim().length > 0
  );
}

export async function readSettingsStorageSnapshot(
  tenantId: string,
): Promise<ReadySettingsStorageSnapshot> {
  if (!hasDatabaseUrl()) {
    const [memory, knowledge] = await Promise.all([
      getMemoryStats({ tenantId }),
      getKnowledgeStats({ tenantId }),
    ]);
    return {
      vectorStore: {
        configured: false,
        dimensions: VECTOR_INDEX_DIMENSIONS,
        hnswSupported:
          VECTOR_INDEX_DIMENSIONS <= PGVECTOR_HNSW_MAX_DIMENSIONS,
        status: "not_configured",
      },
      memory: { ...memory, status: "ready" },
      knowledge: { ...knowledge, status: "ready" },
    };
  }

  await ensureDatabaseSchema();
  const rows = await getSql().transaction(
    async (sql: ReturnType<typeof getSql>) => {
      const statementTimeoutMs = configuredStatementTimeoutMs();
      const lockTimeoutMs = Math.min(statementTimeoutMs, 1_000);
      await sql`
        SELECT
          set_config('statement_timeout', ${String(statementTimeoutMs)}, true),
          set_config('lock_timeout', ${String(lockTimeoutMs)}, true)
      `;
      return sql`
    WITH memory_by_type AS (
      SELECT
        type,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE jsonb_typeof(embedding) = 'array')::int AS embedded
      FROM omni_memories
      WHERE tenant_id = ${tenantId}
      GROUP BY type
    ),
    memory_stats AS (
      SELECT
        COALESCE(SUM(count), 0)::int AS total,
        COALESCE(SUM(embedded), 0)::int AS embedded,
        COALESCE(jsonb_object_agg(type, count), '{}'::jsonb) AS by_type
      FROM memory_by_type
    ),
    knowledge_stats AS (
      SELECT
        COUNT(*)::int AS documents,
        COALESCE(SUM(chunk_count), 0)::int AS chunks,
        COALESCE(SUM(total_characters), 0)::int AS characters
      FROM omni_knowledge_documents
      WHERE tenant_id = ${tenantId}
    ),
    knowledge_embeddings AS (
      SELECT COUNT(*)::int AS embedded
      FROM omni_knowledge_chunks
      WHERE tenant_id = ${tenantId}
        AND jsonb_typeof(embedding) = 'array'
    ),
    vector_metadata AS (
      SELECT
        (
          SELECT extversion::text
          FROM pg_extension
          WHERE extname = 'vector'
          LIMIT 1
        ) AS extension_version,
        (
          SELECT attribute.atttypmod
          FROM pg_attribute attribute
          JOIN pg_class class ON class.oid = attribute.attrelid
          JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
          WHERE namespace.nspname = current_schema()
            AND class.relname = 'omni_memories'
            AND attribute.attname = 'embedding_vector'
            AND NOT attribute.attisdropped
          LIMIT 1
        ) AS memory_dimensions,
        (
          SELECT attribute.atttypmod
          FROM pg_attribute attribute
          JOIN pg_class class ON class.oid = attribute.attrelid
          JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
          WHERE namespace.nspname = current_schema()
            AND class.relname = 'omni_knowledge_chunks'
            AND attribute.attname = 'embedding_vector'
            AND NOT attribute.attisdropped
          LIMIT 1
        ) AS knowledge_dimensions,
        EXISTS (
          SELECT 1
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'omni_memories_embedding_vector_idx'
        ) AS memory_indexed,
        EXISTS (
          SELECT 1
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'omni_knowledge_chunks_embedding_vector_idx'
        ) AS knowledge_indexed
    )
    SELECT
      memory_stats.total AS memory_total,
      memory_stats.embedded AS memory_embedded,
      memory_stats.by_type AS memory_by_type,
      knowledge_stats.documents AS knowledge_documents,
      knowledge_stats.chunks AS knowledge_chunks,
      knowledge_stats.characters AS knowledge_characters,
      knowledge_embeddings.embedded AS knowledge_embedded,
      vector_metadata.extension_version,
      vector_metadata.memory_dimensions,
      vector_metadata.knowledge_dimensions,
      vector_metadata.memory_indexed,
      vector_metadata.knowledge_indexed
    FROM memory_stats
    CROSS JOIN knowledge_stats
    CROSS JOIN knowledge_embeddings
    CROSS JOIN vector_metadata
      `;
    },
  ) as Record<string, unknown>[];
  const row = rows[0] || {};
  const extensionVersion = optionalString(row.extension_version);
  const memoryColumnDimensions = optionalNumber(row.memory_dimensions);
  const knowledgeColumnDimensions = optionalNumber(row.knowledge_dimensions);
  const memoryIndexed = Boolean(row.memory_indexed);
  const knowledgeIndexed = Boolean(row.knowledge_indexed);
  const configured =
    Boolean(extensionVersion) &&
    memoryColumnDimensions === VECTOR_INDEX_DIMENSIONS &&
    knowledgeColumnDimensions === VECTOR_INDEX_DIMENSIONS &&
    memoryIndexed &&
    knowledgeIndexed;

  return {
    vectorStore: {
      configured,
      extensionInstalled: Boolean(extensionVersion),
      ...(extensionVersion ? { extensionVersion } : {}),
      dimensions: VECTOR_INDEX_DIMENSIONS,
      hnswSupported:
        VECTOR_INDEX_DIMENSIONS <= PGVECTOR_HNSW_MAX_DIMENSIONS,
      ...(memoryColumnDimensions === undefined
        ? {}
        : { memoryColumnDimensions }),
      ...(knowledgeColumnDimensions === undefined
        ? {}
        : { knowledgeColumnDimensions }),
      memoryIndexed,
      knowledgeIndexed,
      status: configured ? "ready" : "degraded",
    },
    memory: {
      total: requiredNumber(row.memory_total),
      byType: countMap(row.memory_by_type),
      embedded: requiredNumber(row.memory_embedded),
      status: "ready",
    },
    knowledge: {
      documents: requiredNumber(row.knowledge_documents),
      chunks: requiredNumber(row.knowledge_chunks),
      characters: requiredNumber(row.knowledge_characters),
      embedded: requiredNumber(row.knowledge_embedded),
      status: "ready",
    },
  };
}

function unavailableSettingsStorageSnapshot(
  source: SettingsStorageSource,
  reason: SettingsStorageFailureReason,
): SettingsStorageSnapshot {
  return {
    vectorStore: {
      configured: null,
      extensionInstalled: null,
      dimensions: VECTOR_INDEX_DIMENSIONS,
      hnswSupported:
        VECTOR_INDEX_DIMENSIONS <= PGVECTOR_HNSW_MAX_DIMENSIONS,
      memoryColumnDimensions: null,
      knowledgeColumnDimensions: null,
      memoryIndexed: null,
      knowledgeIndexed: null,
      status: "unavailable",
      unavailableReason: reason,
    },
    memory: {
      total: null,
      byType: null,
      embedded: null,
      status: "unavailable",
      unavailableReason: reason,
    },
    knowledge: {
      documents: null,
      chunks: null,
      characters: null,
      embedded: null,
      status: "unavailable",
      unavailableReason: reason,
    },
    storageSnapshot: {
      status: "degraded",
      source,
      reason,
      checkedAt: new Date().toISOString(),
    },
  };
}

function configuredReadTimeoutMs() {
  const configured = Number(
    process.env.OMNIAGENT_SETTINGS_CAPABILITY_TIMEOUT_MS,
  );
  return Number.isFinite(configured) ? configured : defaultReadTimeoutMs;
}

function configuredStatementTimeoutMs() {
  const configured = Number(
    process.env.OMNIAGENT_SETTINGS_CAPABILITY_STATEMENT_TIMEOUT_MS,
  );
  if (!Number.isFinite(configured)) {
    return defaultStatementTimeoutMs;
  }
  return Math.min(Math.max(Math.round(configured), 1_000), 30_000);
}

function normalizeTimeoutMs(value: number) {
  if (!Number.isFinite(value)) {
    return defaultReadTimeoutMs;
  }
  return Math.min(Math.max(Math.round(value), 1), 5_000);
}

function optionalString(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : undefined;
}

function requiredNumber(value: unknown) {
  return optionalNumber(value) || 0;
}

function countMap(value: unknown): Record<string, number> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(parsed)
      .map(([key, count]) => [key, requiredNumber(count)] as const)
      .filter(([key]) => key.trim().length > 0),
  );
}
