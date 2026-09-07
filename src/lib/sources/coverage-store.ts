import "server-only";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import type { OwnedSourceCoverageInventory } from "@/lib/sources/coverage";

type AggregateRow = Record<string, unknown>;
type OwnedSourceDomain = OwnedSourceCoverageInventory["domains"][number]["id"];

/**
 * Loads counts and verification timestamps only. Content, provider identifiers,
 * credentials, metadata, and incremental cursor values never cross this boundary.
 */
export async function loadOwnedSourceCoverageInventory(input: {
  tenantId: string;
  actorIds: readonly string[];
}): Promise<OwnedSourceCoverageInventory> {
  const tenantId = exactIdentity(input.tenantId, "tenant");
  const [firstActorId, secondActorId] = exactActorPair(input.actorIds);
  if (!hasDatabaseUrl()) {
    throw new Error("Actor-owned source coverage requires the canonical database.");
  }

  await ensureDatabaseSchema();
  const scopedSql = getSql();
  return scopedSql.transaction(async (sql: typeof scopedSql) => {
    const [sourceRows, indexRows, captureRows] = await Promise.all([
      sql`
        SELECT adapter_id, COUNT(*)::integer AS current_items,
          MAX(adapter_observed_at) AS last_observed_at
        FROM omni_source_items
        WHERE tenant_id = ${tenantId}
          AND owner_actor_id IN (${firstActorId}, ${secondActorId})
          AND current_revision_id IS NOT NULL
          AND adapter_operation = 'upsert'
          AND (retention_expires_at IS NULL OR retention_expires_at > CURRENT_TIMESTAMP)
        GROUP BY adapter_id
      `,
      sql`
        WITH current_sources AS MATERIALIZED (
          SELECT id, current_revision_id
          FROM omni_source_items
          WHERE tenant_id = ${tenantId}
            AND owner_actor_id IN (${firstActorId}, ${secondActorId})
            AND current_revision_id IS NOT NULL
            AND adapter_operation = 'upsert'
            AND (retention_expires_at IS NULL OR retention_expires_at > CURRENT_TIMESTAMP)
        ), indexed_documents AS MATERIALIZED (
          SELECT document.id, document.chunk_count, document.updated_at
          FROM omni_knowledge_documents document
          JOIN current_sources source
            ON source.id = document.source_item_id
            AND source.current_revision_id = document.source_revision_id
          WHERE document.tenant_id = ${tenantId}
        ), indexed_chunks AS MATERIALIZED (
          SELECT chunk.id, chunk.embedding
          FROM omni_knowledge_chunks chunk
          JOIN indexed_documents document ON document.id = chunk.document_id
          WHERE chunk.tenant_id = ${tenantId}
        )
        SELECT
          (SELECT COUNT(*)::integer FROM current_sources) AS source_items,
          (SELECT COUNT(*)::integer FROM indexed_documents) AS indexed_documents,
          (SELECT COALESCE(SUM(chunk_count), 0)::integer FROM indexed_documents) AS chunks,
          (SELECT COUNT(*)::integer FROM indexed_chunks
            WHERE jsonb_typeof(embedding) = 'array') AS embedded_chunks,
          (SELECT MAX(updated_at) FROM indexed_documents) AS last_indexed_at
      `,
      sql`
        SELECT
          COALESCE(SUM(total), 0)::integer AS total,
          COALESCE(SUM(indexed), 0)::integer AS indexed,
          COALESCE(SUM(failed), 0)::integer AS failed,
          MAX(last_updated_at) AS last_updated_at
        FROM (
          SELECT COUNT(*)::integer AS total,
            COUNT(*) FILTER (WHERE knowledge_document_id IS NOT NULL)::integer AS indexed,
            COUNT(*) FILTER (
              WHERE knowledge_document_id IS NULL
                AND (status = 'failed' OR extraction_status = 'failed')
            )::integer AS failed,
            MAX(updated_at) AS last_updated_at
          FROM omni_capture_assets
          WHERE tenant_id = ${tenantId}
            AND actor_id IN (${firstActorId}, ${secondActorId})
            AND COALESCE(metadata->>'internalKind', '') = ''
          UNION ALL
          SELECT COUNT(*)::integer AS total,
            COUNT(*) FILTER (WHERE knowledge_document_id IS NOT NULL)::integer AS indexed,
            COUNT(*) FILTER (
              WHERE knowledge_document_id IS NULL AND status = 'failed'
            )::integer AS failed,
            MAX(updated_at) AS last_updated_at
          FROM omni_capture_recordings
          WHERE tenant_id = ${tenantId}
            AND actor_id IN (${firstActorId}, ${secondActorId})
        ) capture_inventory
      `,
    ]);

    const domains = aggregateSourceDomains(sourceRows as AggregateRow[]);
    const index = (indexRows[0] || {}) as AggregateRow;
    const capture = (captureRows[0] || {}) as AggregateRow;
    const total = nonNegativeInteger(capture.total);
    const indexed = Math.min(total, nonNegativeInteger(capture.indexed));
    const failed = Math.min(total - indexed, nonNegativeInteger(capture.failed));

    return Object.freeze({
      domains: Object.freeze(domains),
      knowledgeIndex: Object.freeze({
        sourceItems: nonNegativeInteger(index.source_items),
        indexedDocuments: nonNegativeInteger(index.indexed_documents),
        chunks: nonNegativeInteger(index.chunks),
        embeddedChunks: nonNegativeInteger(index.embedded_chunks),
        lastIndexedAt: optionalTimestamp(index.last_indexed_at),
      }),
      capture: Object.freeze({
        total,
        indexed,
        failed,
        pending: Math.max(0, total - indexed - failed),
        lastUpdatedAt: optionalTimestamp(capture.last_updated_at),
      }),
    });
  }) as Promise<OwnedSourceCoverageInventory>;
}

function aggregateSourceDomains(rows: AggregateRow[]) {
  const aggregate = new Map<OwnedSourceDomain, {
    id: OwnedSourceDomain;
    currentItems: number;
    lastObservedAt: string | null;
  }>();
  for (const row of rows) {
    const id = domainForAdapter(String(row.adapter_id || ""));
    const current = aggregate.get(id);
    const timestamp = optionalTimestamp(row.last_observed_at);
    aggregate.set(id, {
      id,
      currentItems: (current?.currentItems || 0) + nonNegativeInteger(row.current_items),
      lastObservedAt: newestTimestamp(current?.lastObservedAt || null, timestamp),
    });
  }
  return [...aggregate.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function domainForAdapter(adapterId: string): OwnedSourceDomain {
  if (adapterId === "google.personal_sync.mail") return "gmail";
  if (adapterId === "google.personal_sync.calendar") return "google_calendar";
  if (
    adapterId === "google.personal_sync.drive" ||
    adapterId === "google-drive.metadata-canonical"
  ) return "google_drive";
  if (adapterId === "asael.capture") return "capture";
  if ([
    "asael.knowledge_service",
    "asael.ingest_api",
    "asael.portable_restore",
  ].includes(adapterId)) return "knowledge_uploads";
  return "other";
}

function exactActorPair(actorIds: readonly string[]): readonly [string, string] {
  const normalized = [...new Set(actorIds.map((actorId) => exactIdentity(actorId, "actor")))];
  if (normalized.length < 1 || normalized.length > 2) {
    throw new Error("Source coverage requires one exact actor or one canonical actor pair.");
  }
  return [normalized[0], normalized[1] || normalized[0]];
}

function exactIdentity(value: string, label: string) {
  if (!value || value.trim() !== value || value.length > 256) {
    throw new Error(`Source coverage requires an exact ${label} id.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function optionalTimestamp(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function newestTimestamp(left: string | null, right: string | null) {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}
