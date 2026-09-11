import "server-only";

import { createHash } from "node:crypto";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  MARKET_RESEARCH_CONTRACT_VERSION,
  marketBarsProviderResultSchema,
  marketEventReplaySchema,
  marketEventReplaysResultSchema,
  type MarketBar,
  type MarketBarsProviderResult,
  type MarketEventReplay,
  type MarketEventReplaysResult,
  type MarketInstrumentId,
  type MarketInterval,
} from "@/lib/market-research/contracts";
import {
  assertExecutionScopeTenant,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export type PendingMarketReplayEvent = {
  eventId: string;
  eventKey: string;
  occurredAt: string;
};

export async function listPendingMarketReplayEvents(input: {
  tenantId: string;
  actorId: string;
  instrumentId: MarketInstrumentId;
  interval: MarketInterval;
  startDate: string;
  endDate: string;
  limit: number;
}): Promise<PendingMarketReplayEvent[]> {
  assertOwnerScope(input.tenantId, input.actorId);
  if (!hasDatabaseUrl()) return [];
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT
      events.id,
      events.event_key,
      COALESCE(schedule.occurred_at, events.occurred_at) AS occurred_at
    FROM omni_market_macro_events events
    LEFT JOIN LATERAL (
      SELECT observed.occurred_at
      FROM omni_market_macro_event_schedules observed
      WHERE observed.tenant_id = events.tenant_id
        AND observed.owner_actor_id = events.owner_actor_id
        AND observed.event_key = events.event_key
        AND observed.release_date = events.release_date
      ORDER BY observed.imported_at DESC, observed.id DESC
      LIMIT 1
    ) schedule ON TRUE
    WHERE events.tenant_id = ${input.tenantId}
      AND events.owner_actor_id = ${input.actorId}
      AND events.release_date BETWEEN ${input.startDate}::DATE AND ${input.endDate}::DATE
      AND COALESCE(schedule.occurred_at, events.occurred_at) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM omni_market_event_replays replay
        WHERE replay.tenant_id = events.tenant_id
          AND replay.owner_actor_id = events.owner_actor_id
          AND replay.market_event_id = events.id
          AND replay.instrument_id = ${input.instrumentId}
          AND replay.interval = ${input.interval}
      )
    ORDER BY events.release_date DESC, events.event_key ASC
    LIMIT ${input.limit}
  `;
  return rows.map((row) => ({
    eventId: String(row.id),
    eventKey: String(row.event_key),
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
  }));
}

export async function saveMarketEventReplay(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  event: PendingMarketReplayEvent;
  windowStart: string;
  windowEnd: string;
  result: MarketBarsProviderResult;
  sourcePayload: unknown;
  importId: string;
}): Promise<{ inserted: boolean; replay: MarketEventReplay }> {
  assertOwnerScope(input.tenantId, input.actorId);
  assertExecutionScopeTenant(input.executionScope, input.tenantId);
  if (input.executionScope.initiatingActorId !== input.actorId) {
    throw new Error("Market replay actor does not match its execution scope.");
  }
  if (
    !input.sourcePayload ||
    typeof input.sourcePayload !== "object" ||
    Array.isArray(input.sourcePayload)
  ) {
    throw new Error("Market replay source payload must be a JSON object.");
  }
  const result = marketBarsProviderResultSchema.parse(input.result);
  const replay = buildMarketEventReplay({
    event: input.event,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    result,
    tenantId: input.tenantId,
    actorId: input.actorId,
  });
  if (!hasDatabaseUrl()) return { inserted: false, replay };
  await ensureDatabaseSchema();
  const sourcePayloadSha256 = canonicalJsonSha256(input.sourcePayload);
  const metrics = replayMetrics(replay);
  const eventPayloadSha256 = canonicalJsonSha256({
    replayId: replay.id,
    snapshotSha256: replay.snapshotSha256,
    sourcePayloadSha256,
    metrics,
  });
  const inserted = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const rows = await sql`
      INSERT INTO omni_market_event_replays (
        schema_version, id, tenant_id, owner_actor_id, contract_version,
        market_event_id, event_key, instrument_id, provider, provider_symbol,
        provider_timezone, interval, occurred_at, window_start, window_end,
        retrieved_at, bar_count, source_payload_sha256, snapshot_sha256,
        source_payload, normalized_bars, metrics, created_at
      ) VALUES (
        1, ${replay.id}, ${input.tenantId}, ${input.actorId},
        ${MARKET_RESEARCH_CONTRACT_VERSION}, ${replay.eventId},
        ${replay.eventKey}, ${replay.instrumentId}, ${replay.provider},
        ${replay.providerSymbol}, ${result.providerTimezone}, ${replay.interval},
        ${replay.occurredAt}, ${replay.windowStart}, ${replay.windowEnd},
        ${replay.retrievedAt}, ${replay.barCount}, ${sourcePayloadSha256},
        ${replay.snapshotSha256}, ${input.sourcePayload}::JSONB,
        ${result.bars}::JSONB, ${metrics}::JSONB, NOW()
      )
      ON CONFLICT (
        tenant_id, owner_actor_id, market_event_id, instrument_id, interval,
        snapshot_sha256
      ) DO NOTHING
      RETURNING id
    `;
    if (rows[0]) {
      await sql`
        INSERT INTO omni_market_event_replay_events (
          schema_version, id, tenant_id, owner_actor_id, replay_id,
          event_type, import_id, payload_sha256, occurred_at
        ) VALUES (
          1, ${replayLedgerId(input.importId, replay.id)}, ${input.tenantId},
          ${input.actorId}, ${replay.id}, 'market.event_replay.observed',
          ${input.importId}, ${eventPayloadSha256}, NOW()
        )
        ON CONFLICT (tenant_id, id) DO NOTHING
      `;
    }
    return Boolean(rows[0]);
  }) as boolean;
  return { inserted, replay };
}

export async function listMarketEventReplays(input: {
  tenantId: string;
  actorId: string;
  instrumentId: MarketInstrumentId;
  limit: number;
}): Promise<MarketEventReplaysResult> {
  assertOwnerScope(input.tenantId, input.actorId);
  if (!hasDatabaseUrl()) return emptyReplayResult(input.instrumentId);
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT *
    FROM (
      SELECT DISTINCT ON (market_event_id)
        *
      FROM omni_market_event_replays
      WHERE tenant_id = ${input.tenantId}
        AND owner_actor_id = ${input.actorId}
        AND instrument_id = ${input.instrumentId}
      ORDER BY market_event_id, retrieved_at DESC, id DESC
    ) latest
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${input.limit}
  `;
  const totals = await getSql()`
    SELECT
      COUNT(DISTINCT events.id)::INTEGER AS eligible_events,
      COUNT(DISTINCT replay.market_event_id)::INTEGER AS replayed_events,
      MAX(replay.created_at) AS last_replayed_at
    FROM omni_market_macro_events events
    LEFT JOIN LATERAL (
      SELECT observed.occurred_at
      FROM omni_market_macro_event_schedules observed
      WHERE observed.tenant_id = events.tenant_id
        AND observed.owner_actor_id = events.owner_actor_id
        AND observed.event_key = events.event_key
        AND observed.release_date = events.release_date
      ORDER BY observed.imported_at DESC, observed.id DESC
      LIMIT 1
    ) schedule ON TRUE
    LEFT JOIN omni_market_event_replays replay
      ON replay.tenant_id = events.tenant_id
      AND replay.owner_actor_id = events.owner_actor_id
      AND replay.market_event_id = events.id
      AND replay.instrument_id = ${input.instrumentId}
    WHERE events.tenant_id = ${input.tenantId}
      AND events.owner_actor_id = ${input.actorId}
      AND COALESCE(schedule.occurred_at, events.occurred_at) IS NOT NULL
  `;
  const eligibleEvents = Number(totals[0]?.eligible_events || 0);
  const replayedEvents = Number(totals[0]?.replayed_events || 0);
  return marketEventReplaysResultSchema.parse({
    contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
    instrumentId: input.instrumentId,
    replays: rows.map(marketReplayFromRow),
    eligibleEvents,
    replayedEvents,
    remainingEvents: Math.max(0, eligibleEvents - replayedEvents),
    lastReplayedAt: totals[0]?.last_replayed_at
      ? new Date(String(totals[0].last_replayed_at)).toISOString()
      : null,
  });
}

export function buildMarketEventReplay(input: {
  event: PendingMarketReplayEvent;
  windowStart: string;
  windowEnd: string;
  result: MarketBarsProviderResult;
  tenantId: string;
  actorId: string;
}): MarketEventReplay {
  const result = marketBarsProviderResultSchema.parse(input.result);
  const intervalSeconds = intervalDurationSeconds(result.interval);
  const occurredAtSeconds = Date.parse(input.event.occurredAt) / 1_000;
  const completedAt = (bar: MarketBar) => bar.time + intervalSeconds;
  const baseline = result.bars.filter((bar) => completedAt(bar) <= occurredAtSeconds).at(-1);
  if (!baseline) {
    throw new MarketReplayInsufficientDataError(
      "The provider range has no completed pre-event baseline bar.",
    );
  }
  const point = (minutes: number) => {
    const target = occurredAtSeconds + minutes * 60;
    const bar = result.bars.filter((candidate) =>
      completedAt(candidate) > occurredAtSeconds && completedAt(candidate) <= target
    ).at(-1);
    if (!bar) return null;
    return {
      timestamp: bar.timestamp,
      close: bar.close,
      returnBps: basisPoints(bar.close, baseline.close),
    };
  };
  const pre60 = result.bars.filter((bar) =>
    completedAt(bar) > occurredAtSeconds - 60 * 60 && completedAt(bar) <= occurredAtSeconds
  );
  const post60 = result.bars.filter((bar) =>
    completedAt(bar) > occurredAtSeconds && completedAt(bar) <= occurredAtSeconds + 60 * 60
  );
  const post240 = result.bars.filter((bar) =>
    completedAt(bar) > occurredAtSeconds && completedAt(bar) <= occurredAtSeconds + 240 * 60
  );
  const post60m = point(60);
  const snapshotSha256 = canonicalJsonSha256({
    contractVersion: result.contractVersion,
    eventId: input.event.eventId,
    eventKey: input.event.eventKey,
    instrumentId: result.instrumentId,
    provider: result.provider,
    providerSymbol: result.providerSymbol,
    interval: result.interval,
    occurredAt: input.event.occurredAt,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    bars: result.bars,
  });
  return marketEventReplaySchema.parse({
    id: replayId(input.tenantId, input.actorId, input.event.eventId, result.instrumentId, result.interval, snapshotSha256),
    eventId: input.event.eventId,
    eventKey: input.event.eventKey,
    instrumentId: result.instrumentId,
    provider: result.provider,
    providerSymbol: result.providerSymbol,
    interval: result.interval,
    occurredAt: input.event.occurredAt,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    retrievedAt: result.retrievedAt,
    barCount: result.bars.length,
    snapshotSha256,
    baseline: { timestamp: baseline.timestamp, close: baseline.close },
    post5m: point(5),
    post15m: point(15),
    post60m,
    post240m: point(240),
    pre60mRangeBps: rangeBps(pre60, baseline.close),
    post60mRangeBps: rangeBps(post60, baseline.close),
    maxFavorableBps: post240.length
      ? Math.max(0, ...post240.map((bar) => basisPoints(bar.high, baseline.close)))
      : null,
    maxAdverseBps: post240.length
      ? Math.max(0, ...post240.map((bar) => -basisPoints(bar.low, baseline.close)))
      : null,
    direction: !post60m
      ? "insufficient_data"
      : post60m.returnBps > 1
        ? "up"
        : post60m.returnBps < -1
          ? "down"
          : "flat",
  });
}

export class MarketReplayInsufficientDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketReplayInsufficientDataError";
  }
}

function marketReplayFromRow(row: Record<string, unknown>) {
  const metrics = typeof row.metrics === "string"
    ? JSON.parse(row.metrics)
    : row.metrics;
  return marketEventReplaySchema.parse({
    id: String(row.id),
    eventId: String(row.market_event_id),
    eventKey: String(row.event_key),
    instrumentId: String(row.instrument_id),
    provider: String(row.provider),
    providerSymbol: String(row.provider_symbol),
    interval: String(row.interval),
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
    windowStart: new Date(String(row.window_start)).toISOString(),
    windowEnd: new Date(String(row.window_end)).toISOString(),
    retrievedAt: new Date(String(row.retrieved_at)).toISOString(),
    barCount: Number(row.bar_count),
    snapshotSha256: String(row.snapshot_sha256),
    ...(metrics as Record<string, unknown>),
  });
}

function replayMetrics(replay: MarketEventReplay) {
  return {
    baseline: replay.baseline,
    post5m: replay.post5m,
    post15m: replay.post15m,
    post60m: replay.post60m,
    post240m: replay.post240m,
    pre60mRangeBps: replay.pre60mRangeBps,
    post60mRangeBps: replay.post60mRangeBps,
    maxFavorableBps: replay.maxFavorableBps,
    maxAdverseBps: replay.maxAdverseBps,
    direction: replay.direction,
  };
}

function rangeBps(bars: MarketBar[], baseline: number) {
  if (!bars.length) return null;
  const high = Math.max(...bars.map((bar) => bar.high));
  const low = Math.min(...bars.map((bar) => bar.low));
  return Math.abs((high - low) / baseline * 10_000);
}

function basisPoints(value: number, baseline: number) {
  return (value - baseline) / baseline * 10_000;
}

function intervalDurationSeconds(interval: MarketInterval) {
  if (interval === "5min") return 5 * 60;
  if (interval === "15min") return 15 * 60;
  return 60 * 60;
}

function replayId(
  tenantId: string,
  actorId: string,
  eventId: string,
  instrumentId: string,
  interval: string,
  snapshotSha256: string,
) {
  return `market_replay_${digest(`${tenantId}:${actorId}:${eventId}:${instrumentId}:${interval}:${snapshotSha256}`)}`;
}

function replayLedgerId(importId: string, id: string) {
  return `market_replay_ledger_${digest(`${importId}:${id}`)}`;
}

function emptyReplayResult(instrumentId: MarketInstrumentId) {
  return marketEventReplaysResultSchema.parse({
    contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
    instrumentId,
    replays: [],
    eligibleEvents: 0,
    replayedEvents: 0,
    remainingEvents: 0,
    lastReplayedAt: null,
  });
}

function assertOwnerScope(tenantId: string, actorId: string) {
  if (!tenantId.trim() || !actorId.trim()) {
    throw new Error("Market replay tenant and actor scope are required.");
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 48);
}
