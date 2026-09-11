import "server-only";

import { createHash } from "node:crypto";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  MARKET_RESEARCH_CONTRACT_VERSION,
  marketEventSchema,
  marketEventsResultSchema,
  type MarketEvent,
  type MarketEventsResult,
} from "@/lib/market-research/contracts";
import type { FredReleaseDate } from "@/lib/market-research/fred";
import type { OfficialMarketScheduleEntry } from "@/lib/market-research/official-schedules";
import {
  assertExecutionScopeTenant,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export async function saveFredMarketEvents(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  dates: readonly FredReleaseDate[];
  importId: string;
}) {
  if (!input.dates.length) return { inserted: 0 };
  assertExecutionScopeTenant(input.executionScope, input.tenantId);
  if (input.executionScope.initiatingActorId !== input.actorId) {
    throw new Error("Market event import actor does not match its execution scope.");
  }
  if (!hasDatabaseUrl()) return { inserted: 0 };
  await ensureDatabaseSchema();
  const importedAt = new Date().toISOString();
  const events = input.dates.map((item) => marketEventFromFred(item, importedAt));
  const sourceShaById = new Map(events.map((event) => [
    event.id,
    canonicalJsonSha256({
      source: event.source,
      sourceReleaseId: event.sourceReleaseId,
      releaseDate: event.releaseDate,
      timestampPrecision: event.timestampPrecision,
    }),
  ]));
  const inserted = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const rows = await sql`
      INSERT INTO omni_market_macro_events (
        schema_version, id, tenant_id, owner_actor_id, event_key, name,
        currency, impact, source, source_release_id, source_url,
        release_date, occurred_at, timestamp_precision, actual, consensus,
        previous, revised, value_status, source_sha256, imported_at
      )
      SELECT
        1, source.id, ${input.tenantId}, ${input.actorId}, source.event_key,
        source.name, 'USD', 'high', 'fred', source.release_id,
        source.source_url, source.release_date, NULL, 'date', NULL, NULL,
        NULL, NULL, 'release_date_only', source.source_sha256,
        NOW()
      FROM UNNEST(
        ${events.map((event) => event.id)}::TEXT[],
        ${events.map((event) => event.eventKey)}::TEXT[],
        ${events.map((event) => event.name)}::TEXT[],
        ${events.map((event) => event.sourceReleaseId)}::INTEGER[],
        ${events.map((event) => event.sourceUrl)}::TEXT[],
        ${events.map((event) => event.releaseDate)}::DATE[],
        ${events.map((event) => sourceShaById.get(event.id)!)}::TEXT[]
      ) AS source(
        id, event_key, name, release_id, source_url, release_date,
        source_sha256
      )
        ON CONFLICT (tenant_id, owner_actor_id, source, source_release_id, release_date)
        DO NOTHING
      RETURNING id
    `;
    if (rows.length) {
      const insertedIds = rows.map((row) => String(row.id));
      await sql`
        INSERT INTO omni_market_macro_event_events (
          schema_version, id, tenant_id, owner_actor_id, market_event_id,
          event_type, import_id, payload_sha256, occurred_at
        )
        SELECT
          1, source.ledger_id, ${input.tenantId}, ${input.actorId},
          source.market_event_id, 'market.macro_event.imported',
          ${input.importId}, source.payload_sha256, NOW()
        FROM UNNEST(
          ${insertedIds.map((id) => marketEventLedgerId(input.importId, id))}::TEXT[],
          ${insertedIds}::TEXT[],
          ${insertedIds.map((id) => sourceShaById.get(id)!)}::TEXT[]
        ) AS source(ledger_id, market_event_id, payload_sha256)
        ON CONFLICT (tenant_id, id) DO NOTHING
      `;
    }
    return rows.length;
  }) as number;
  return { inserted };
}

export async function saveOfficialMarketEventSchedules(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  entries: readonly OfficialMarketScheduleEntry[];
  importId: string;
}) {
  if (!input.entries.length) return { inserted: 0 };
  assertExecutionScopeTenant(input.executionScope, input.tenantId);
  if (input.executionScope.initiatingActorId !== input.actorId) {
    throw new Error("Market schedule import actor does not match its execution scope.");
  }
  if (!hasDatabaseUrl()) return { inserted: 0 };
  await ensureDatabaseSchema();
  const sourceShaById = new Map(input.entries.map((entry) => {
    const id = marketScheduleId(entry.source, entry.eventKey, entry.occurredAt);
    return [id, canonicalJsonSha256({
      source: entry.source,
      eventKey: entry.eventKey,
      sourceUidSha256: digestFull(entry.sourceUid),
      sourceUrl: entry.sourceUrl,
      releaseDate: entry.releaseDate,
      occurredAt: entry.occurredAt,
      timezone: entry.timezone,
    })] as const;
  }));
  const inserted = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const rows = await sql`
      INSERT INTO omni_market_macro_event_schedules (
        schema_version, id, tenant_id, owner_actor_id, event_key, name,
        currency, impact, source, source_uid_sha256, source_url,
        release_date, occurred_at, timezone, source_sha256, imported_at
      )
      SELECT
        1, source.id, ${input.tenantId}, ${input.actorId}, source.event_key,
        source.name, 'USD', 'high', source.schedule_source, source.source_uid_sha256,
        source.source_url, source.release_date, source.occurred_at,
        source.timezone, source.source_sha256, NOW()
      FROM UNNEST(
        ${input.entries.map((entry) => marketScheduleId(entry.source, entry.eventKey, entry.occurredAt))}::TEXT[],
        ${input.entries.map((entry) => entry.eventKey)}::TEXT[],
        ${input.entries.map((entry) => entry.name)}::TEXT[],
        ${input.entries.map((entry) => entry.source)}::TEXT[],
        ${input.entries.map((entry) => digestFull(entry.sourceUid))}::TEXT[],
        ${input.entries.map((entry) => entry.sourceUrl)}::TEXT[],
        ${input.entries.map((entry) => entry.releaseDate)}::DATE[],
        ${input.entries.map((entry) => entry.occurredAt)}::TIMESTAMPTZ[],
        ${input.entries.map((entry) => entry.timezone)}::TEXT[],
        ${input.entries.map((entry) => sourceShaById.get(marketScheduleId(entry.source, entry.eventKey, entry.occurredAt))!)}::TEXT[]
      ) AS source(
        id, event_key, name, schedule_source, source_uid_sha256, source_url,
        release_date, occurred_at, timezone, source_sha256
      )
      ON CONFLICT (tenant_id, owner_actor_id, source, event_key, occurred_at)
      DO NOTHING
      RETURNING id
    `;
    if (rows.length) {
      const insertedIds = rows.map((row) => String(row.id));
      await sql`
        INSERT INTO omni_market_macro_event_schedule_events (
          schema_version, id, tenant_id, owner_actor_id, schedule_id,
          event_type, import_id, payload_sha256, occurred_at
        )
        SELECT
          1, source.ledger_id, ${input.tenantId}, ${input.actorId},
          source.schedule_id, 'market.macro_event.schedule_observed',
          ${input.importId}, source.payload_sha256, NOW()
        FROM UNNEST(
          ${insertedIds.map((id) => marketScheduleLedgerId(input.importId, id))}::TEXT[],
          ${insertedIds}::TEXT[],
          ${insertedIds.map((id) => sourceShaById.get(id)!)}::TEXT[]
        ) AS source(ledger_id, schedule_id, payload_sha256)
        ON CONFLICT (tenant_id, id) DO NOTHING
      `;
    }
    return rows.length;
  }) as number;
  return { inserted };
}

export async function listMarketEvents(input: {
  tenantId: string;
  actorId: string;
  limit: number;
}): Promise<MarketEventsResult> {
  if (!hasDatabaseUrl()) {
    return marketEventsResultSchema.parse({
      contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
      events: [],
      total: 0,
      lastImportedAt: null,
    });
  }
  await ensureDatabaseSchema();
  const rows = await getSql()`
      SELECT
        events.*,
        schedule.occurred_at AS schedule_occurred_at,
        schedule.source AS schedule_source,
        schedule.source_url AS schedule_source_url
      FROM omni_market_macro_events events
      LEFT JOIN LATERAL (
        SELECT occurred_at, source, source_url
        FROM omni_market_macro_event_schedules schedules
        WHERE schedules.tenant_id = events.tenant_id
          AND schedules.owner_actor_id = events.owner_actor_id
          AND schedules.event_key = events.event_key
          AND schedules.release_date = events.release_date
        ORDER BY schedules.imported_at DESC, schedules.id DESC
        LIMIT 1
      ) schedule ON TRUE
      WHERE events.tenant_id = ${input.tenantId}
        AND events.owner_actor_id = ${input.actorId}
        AND (
          events.event_key <> 'us.fomc'
          OR schedule.occurred_at IS NOT NULL
        )
      ORDER BY events.release_date DESC, events.event_key ASC
      LIMIT ${input.limit}
    `;
  const totals = await getSql()`
      SELECT COUNT(*)::INTEGER AS total, MAX(imported_at) AS last_imported_at
      FROM omni_market_macro_events
      WHERE tenant_id = ${input.tenantId}
        AND owner_actor_id = ${input.actorId}
        AND (
          event_key <> 'us.fomc'
          OR EXISTS (
            SELECT 1
            FROM omni_market_macro_event_schedules schedules
            WHERE schedules.tenant_id = omni_market_macro_events.tenant_id
              AND schedules.owner_actor_id = omni_market_macro_events.owner_actor_id
              AND schedules.event_key = omni_market_macro_events.event_key
              AND schedules.release_date = omni_market_macro_events.release_date
          )
        )
    `;
  return marketEventsResultSchema.parse({
    contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
    events: rows.map(marketEventFromRow),
    total: Number(totals[0]?.total || 0),
    lastImportedAt: totals[0]?.last_imported_at
      ? new Date(String(totals[0].last_imported_at)).toISOString()
      : null,
  });
}

function marketEventFromFred(item: FredReleaseDate, importedAt: string): MarketEvent {
  return marketEventSchema.parse({
    id: marketEventId(item.releaseId, item.releaseDate),
    eventKey: item.eventKey,
    name: item.name,
    currency: "USD",
    impact: "high",
    source: "fred",
    sourceReleaseId: item.releaseId,
    sourceUrl: item.sourceUrl,
    releaseDate: item.releaseDate,
    occurredAt: null,
    timestampPrecision: "date",
    scheduleSource: null,
    scheduleSourceUrl: null,
    actual: null,
    consensus: null,
    previous: null,
    revised: null,
    valueStatus: "release_date_only",
    importedAt,
  });
}

function marketEventFromRow(row: Record<string, unknown>): MarketEvent {
  return marketEventSchema.parse({
    id: String(row.id),
    eventKey: String(row.event_key),
    name: String(row.name),
    currency: String(row.currency),
    impact: String(row.impact),
    source: String(row.source),
    sourceReleaseId: Number(row.source_release_id),
    sourceUrl: String(row.source_url),
    releaseDate: new Date(String(row.release_date)).toISOString().slice(0, 10),
    occurredAt: row.schedule_occurred_at || row.occurred_at
      ? new Date(String(row.schedule_occurred_at || row.occurred_at)).toISOString()
      : null,
    timestampPrecision: row.schedule_occurred_at
      ? "instant"
      : String(row.timestamp_precision),
    scheduleSource: row.schedule_source ? String(row.schedule_source) : null,
    scheduleSourceUrl: row.schedule_source_url
      ? String(row.schedule_source_url)
      : null,
    actual: nullableNumber(row.actual),
    consensus: nullableNumber(row.consensus),
    previous: nullableNumber(row.previous),
    revised: nullableNumber(row.revised),
    valueStatus: String(row.value_status),
    importedAt: new Date(String(row.imported_at)).toISOString(),
  });
}

function marketEventId(releaseId: number, releaseDate: string) {
  return `market_event_${digest(`fred:${releaseId}:${releaseDate}`)}`;
}

function marketEventLedgerId(importId: string, eventId: string) {
  return `market_event_ledger_${digest(`${importId}:${eventId}`)}`;
}

function marketScheduleId(
  source: OfficialMarketScheduleEntry["source"],
  eventKey: string,
  occurredAt: string,
) {
  return `market_schedule_${digest(`${source}:${eventKey}:${occurredAt}`)}`;
}

function marketScheduleLedgerId(importId: string, scheduleId: string) {
  return `market_schedule_ledger_${digest(`${importId}:${scheduleId}`)}`;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 48);
}

function digestFull(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
