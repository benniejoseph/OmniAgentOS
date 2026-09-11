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
      SELECT * FROM omni_market_macro_events
      WHERE tenant_id = ${input.tenantId}
        AND owner_actor_id = ${input.actorId}
      ORDER BY release_date DESC, event_key ASC
      LIMIT ${input.limit}
    `;
  const totals = await getSql()`
      SELECT COUNT(*)::INTEGER AS total, MAX(imported_at) AS last_imported_at
      FROM omni_market_macro_events
      WHERE tenant_id = ${input.tenantId}
        AND owner_actor_id = ${input.actorId}
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
    occurredAt: row.occurred_at
      ? new Date(String(row.occurred_at)).toISOString()
      : null,
    timestampPrecision: String(row.timestamp_precision),
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

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 48);
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
