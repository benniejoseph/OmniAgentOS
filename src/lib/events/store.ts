import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { redactSensitive } from "@/lib/security/context";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";

/**
 * Event-log substrate, stage 1 (see docs/vision/EVENT_LOG.md).
 *
 * One append-only log; existing stores dual-write into it. State is meant to
 * be a projection of this log — `src/lib/events/projections.ts` proves it for
 * trust profiles. Ordering uses a global sequence (BIGSERIAL in Postgres,
 * counter in file mode); per-stream order is derived from it.
 */

export type DomainEvent = {
  id: string;
  seq: number;
  streamId: string;
  type: string;
  tenantId: string;
  actorId: string;
  payload: Record<string, unknown>;
  causationId?: string;
  correlationId?: string;
  at: string;
};

export type AppendDomainEventInput = {
  streamId: string;
  type: string;
  tenantId?: string;
  actorId?: string;
  payload?: Record<string, unknown>;
  causationId?: string;
  correlationId?: string;
};

type EventLedger = {
  nextSeq: number;
  events: DomainEvent[];
};

const FILE_EVENT_CAP = 5_000;

type EventSqlClient = ReturnType<typeof getSql>;

export async function appendDomainEvent(
  input: AppendDomainEventInput,
  options: { sql?: EventSqlClient } = {},
): Promise<DomainEvent> {
  const event: DomainEvent = {
    id: randomUUID(),
    seq: 0,
    streamId: input.streamId,
    type: input.type,
    tenantId: normalizeTenantId(input.tenantId),
    actorId: input.actorId || "system",
    payload: boundedEventPayload(input.payload || {}),
    causationId: input.causationId,
    correlationId: input.correlationId,
    at: new Date().toISOString(),
  };

  if (hasDatabaseUrl()) {
    if (!options.sql) {
      await ensureDatabaseSchema();
    }
    const sql = options.sql || getSql();
    const rows = await sql`
      INSERT INTO omni_events (id, stream_id, type, tenant_id, actor_id, payload, causation_id, correlation_id, at)
      VALUES (
        ${event.id}, ${event.streamId}, ${event.type}, ${event.tenantId}, ${event.actorId},
        ${event.payload}::jsonb, ${event.causationId || null}, ${event.correlationId || null}, ${event.at}
      )
      RETURNING seq
    `;
    return { ...event, seq: Number(rows[0]?.seq || 0) };
  }

  await updateJsonFile<EventLedger>(getEventsFile(), { nextSeq: 1, events: [] }, (ledger) => {
    event.seq = ledger.nextSeq;
    ledger.nextSeq += 1;
    ledger.events.push(event);
    if (ledger.events.length > FILE_EVENT_CAP) {
      ledger.events = ledger.events.slice(-FILE_EVENT_CAP);
    }
    return ledger;
  });
  return event;
}

function boundedEventPayload(payload: Record<string, unknown>) {
  const redacted = redactSensitive(payload) as Record<string, unknown>;
  const serialized = JSON.stringify(redacted);
  if (Buffer.byteLength(serialized, "utf8") <= 64_000) {
    return redacted;
  }
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    preview: serialized.slice(0, 32_000),
  };
}

/** Dual-write helper: the log must never take down the primary write path. */
export async function appendDomainEventSafely(
  input: AppendDomainEventInput,
  options: { sql?: EventSqlClient } = {},
): Promise<DomainEvent | undefined> {
  try {
    return await appendDomainEvent(input, options);
  } catch (error) {
    console.warn("Domain event append failed.", error instanceof Error ? error.message : error);
    return undefined;
  }
}

export async function listStreamEvents(
  streamId: string,
  options: {
    tenantId?: string;
    actorId?: string;
    afterSeq?: number;
    limit?: number;
    order?: "asc" | "desc";
  } = {},
): Promise<DomainEvent[]> {
  const limit = Math.min(Math.max(options.limit || 500, 1), 2_000);
  const afterSeq = Math.max(Math.trunc(options.afterSeq || 0), 0);
  const order = options.order === "desc" ? "desc" : "asc";

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const params: unknown[] = [streamId, afterSeq];
    const predicates = ["stream_id = $1", "seq > $2"];
    if (options.tenantId) {
      params.push(normalizeTenantId(options.tenantId));
      predicates.push(`tenant_id = $${params.length}`);
    }
    if (options.actorId) {
      params.push(options.actorId);
      predicates.push(`actor_id = $${params.length}`);
    }
    params.push(limit);
    const rows = await getSql().query(
      `SELECT * FROM omni_events
       WHERE ${predicates.join(" AND ")}
       ORDER BY seq ${order === "desc" ? "DESC" : "ASC"}
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(eventFromRow);
  }

  const ledger = await readLedger();
  const events = ledger.events
    .filter(
      (event) =>
        event.streamId === streamId &&
        event.seq > afterSeq &&
        (!options.tenantId || event.tenantId === normalizeTenantId(options.tenantId)) &&
        (!options.actorId || event.actorId === options.actorId),
    )
    .sort((left, right) => left.seq - right.seq);
  if (order === "desc") events.reverse();
  return events
    .slice(0, limit);
}

export async function listRecentEvents(
  options: { tenantId: string; limit?: number; type?: string } = { tenantId: "default" },
): Promise<DomainEvent[]> {
  const limit = Math.min(Math.max(options.limit || 50, 1), 500);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = options.type
      ? await getSql()`
          SELECT * FROM omni_events
          WHERE tenant_id = ${options.tenantId} AND type = ${options.type}
          ORDER BY seq DESC
          LIMIT ${limit}
        `
      : await getSql()`
          SELECT * FROM omni_events
          WHERE tenant_id = ${options.tenantId}
          ORDER BY seq DESC
          LIMIT ${limit}
        `;
    return rows.map(eventFromRow);
  }

  const ledger = await readLedger();
  return ledger.events
    .filter(
      (event) =>
        event.tenantId === normalizeTenantId(options.tenantId) &&
        (!options.type || event.type === options.type),
    )
    .sort((left, right) => right.seq - left.seq)
    .slice(0, limit);
}

function eventFromRow(row: Record<string, unknown>): DomainEvent {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    streamId: String(row.stream_id),
    type: String(row.type),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    payload: (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>,
    causationId: row.causation_id ? String(row.causation_id) : undefined,
    correlationId: row.correlation_id ? String(row.correlation_id) : undefined,
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
  };
}

async function readLedger() {
  return readJsonFile<EventLedger>(getEventsFile(), { nextSeq: 1, events: [] });
}

function getEventsFile() {
  return getDataPath("events.json");
}

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}
