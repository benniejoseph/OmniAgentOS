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
  marketBarsResultSchema,
  type MarketBarsProviderResult,
  type MarketBarsResult,
  type MarketInterval,
  type MarketInstrumentId,
} from "@/lib/market-research/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const cacheTtlMs: Record<MarketInterval, number> = {
  "5min": 60_000,
  "15min": 2 * 60_000,
  "1h": 5 * 60_000,
};

export class MarketPriceSnapshotStoreUnavailableError extends Error {
  constructor() {
    super("Immutable market price snapshots require the configured database.");
    this.name = "MarketPriceSnapshotStoreUnavailableError";
  }
}

export async function findFreshMarketPriceSnapshot(input: {
  tenantId: string;
  actorId: string;
  instrumentId: MarketInstrumentId;
  interval: MarketInterval;
  outputSize: number;
}): Promise<MarketBarsResult | null> {
  assertOwnerScope(input.tenantId, input.actorId);
  if (!hasDatabaseUrl()) return null;
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT *
    FROM omni_market_price_snapshots
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND contract_version = ${MARKET_RESEARCH_CONTRACT_VERSION}
      AND instrument_id = ${input.instrumentId}
      AND interval = ${input.interval}
      AND requested_output_size = ${input.outputSize}
      AND created_at >= NOW() - (
        ${cacheTtlMs[input.interval]}::BIGINT * INTERVAL '1 millisecond'
      )
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;
  return rows[0] ? marketSnapshotFromRow(rows[0], "cache") : null;
}

export async function saveMarketPriceSnapshot(input: {
  tenantId: string;
  actorId: string;
  outputSize: number;
  result: MarketBarsProviderResult;
  sourcePayload: unknown;
}): Promise<MarketBarsResult> {
  assertOwnerScope(input.tenantId, input.actorId);
  const result = marketBarsProviderResultSchema.parse(input.result);
  if (
    !input.sourcePayload ||
    typeof input.sourcePayload !== "object" ||
    Array.isArray(input.sourcePayload)
  ) {
    throw new Error("Market snapshot source payload must be a JSON object.");
  }
  if (!hasDatabaseUrl()) throw new MarketPriceSnapshotStoreUnavailableError();
  await ensureDatabaseSchema();

  const normalizedSha256 = canonicalJsonSha256(normalizedSnapshotPayload(result));
  const sourcePayloadSha256 = canonicalJsonSha256(input.sourcePayload);
  const snapshotId = marketSnapshotId(
    input.tenantId,
    input.actorId,
    normalizedSha256,
  );
  const eventPayloadSha256 = canonicalJsonSha256({
    snapshotId,
    normalizedSha256,
    sourcePayloadSha256,
  });

  await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const inserted = await sql`
      INSERT INTO omni_market_price_snapshots (
        schema_version, id, tenant_id, owner_actor_id, contract_version,
        instrument_id, provider, provider_symbol, provider_timezone, interval,
        requested_output_size, retrieved_at, as_of, first_bar_at, last_bar_at,
        bar_count, source_payload_sha256, normalized_sha256, source_payload,
        normalized_bars, created_at
      ) VALUES (
        1, ${snapshotId}, ${input.tenantId}, ${input.actorId},
        ${result.contractVersion}, ${result.instrumentId}, ${result.provider},
        ${result.providerSymbol}, ${result.providerTimezone}, ${result.interval},
        ${input.outputSize}, ${result.retrievedAt}, ${result.asOf},
        ${result.bars[0]?.timestamp}, ${result.bars.at(-1)?.timestamp},
        ${result.bars.length}, ${sourcePayloadSha256}, ${normalizedSha256},
        ${input.sourcePayload}::JSONB, ${result.bars}::JSONB, NOW()
      )
      ON CONFLICT (tenant_id, owner_actor_id, normalized_sha256) DO NOTHING
      RETURNING id
    `;
    if (inserted[0]) {
      await sql`
        INSERT INTO omni_market_price_snapshot_events (
          schema_version, id, tenant_id, owner_actor_id, snapshot_id,
          event_type, payload_sha256, occurred_at
        ) VALUES (
          1, ${marketSnapshotEventId(snapshotId)}, ${input.tenantId},
          ${input.actorId}, ${snapshotId}, 'market.price_snapshot.observed',
          ${eventPayloadSha256}, NOW()
        )
        ON CONFLICT (tenant_id, id) DO NOTHING
      `;
    }
  });

  const rows = await getSql()`
    SELECT * FROM omni_market_price_snapshots
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND normalized_sha256 = ${normalizedSha256}
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new Error("The immutable market snapshot could not be read back.");
  }
  return marketSnapshotFromRow(rows[0], "provider");
}

export function marketPriceSnapshotIdentity(input: {
  tenantId: string;
  actorId: string;
  result: MarketBarsProviderResult;
}) {
  assertOwnerScope(input.tenantId, input.actorId);
  const result = marketBarsProviderResultSchema.parse(input.result);
  const snapshotSha256 = canonicalJsonSha256(normalizedSnapshotPayload(result));
  return {
    snapshotId: marketSnapshotId(
      input.tenantId,
      input.actorId,
      snapshotSha256,
    ),
    snapshotSha256,
  };
}

function marketSnapshotFromRow(
  row: Record<string, unknown>,
  snapshotSource: "provider" | "cache",
) {
  const bars = Array.isArray(row.normalized_bars)
    ? row.normalized_bars
    : JSON.parse(String(row.normalized_bars));
  return marketBarsResultSchema.parse({
    contractVersion: String(row.contract_version),
    instrumentId: String(row.instrument_id),
    provider: String(row.provider),
    providerSymbol: String(row.provider_symbol),
    providerTimezone: String(row.provider_timezone),
    interval: String(row.interval),
    retrievedAt: new Date(String(row.retrieved_at)).toISOString(),
    asOf: new Date(String(row.as_of)).toISOString(),
    bars,
    snapshotId: String(row.id),
    snapshotSha256: String(row.normalized_sha256),
    snapshotSource,
  });
}

function normalizedSnapshotPayload(result: MarketBarsProviderResult) {
  return {
    contractVersion: result.contractVersion,
    instrumentId: result.instrumentId,
    provider: result.provider,
    providerSymbol: result.providerSymbol,
    providerTimezone: result.providerTimezone,
    interval: result.interval,
    asOf: result.asOf,
    bars: result.bars,
  };
}

function marketSnapshotId(
  tenantId: string,
  actorId: string,
  normalizedSha256: string,
) {
  return `market_snapshot_${digest(`${tenantId}:${actorId}:${normalizedSha256}`)}`;
}

function marketSnapshotEventId(snapshotId: string) {
  return `market_snapshot_event_${digest(snapshotId)}`;
}

function assertOwnerScope(tenantId: string, actorId: string) {
  if (!tenantId.trim() || !actorId.trim()) {
    throw new Error("Market snapshot tenant and actor scope are required.");
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 48);
}
