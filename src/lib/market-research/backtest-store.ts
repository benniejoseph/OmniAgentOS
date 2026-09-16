import "server-only";

import { createHash } from "node:crypto";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  MARKET_RESEARCH_CONTRACT_VERSION,
  marketBacktestSchema,
  marketBacktestsResultSchema,
  type MarketBacktest,
  type MarketBacktestsResult,
  type MarketInstrumentId,
} from "@/lib/market-research/contracts";
import {
  assertExecutionScopeTenant,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export class MarketBacktestStoreUnavailableError extends Error {
  constructor() {
    super("Immutable market backtests require the configured database.");
    this.name = "MarketBacktestStoreUnavailableError";
  }
}

export async function saveMarketBacktest(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  operationJobId: string;
  backtest: MarketBacktest;
}) {
  assertOwnerScope(input.tenantId, input.actorId);
  assertExecutionScopeTenant(input.executionScope, input.tenantId);
  if (input.executionScope.initiatingActorId !== input.actorId) {
    throw new Error("Market backtest actor does not match its execution scope.");
  }
  const backtest = marketBacktestSchema.parse(input.backtest);
  if (!hasDatabaseUrl()) throw new MarketBacktestStoreUnavailableError();
  await ensureDatabaseSchema();
  const manifestSha256 = canonicalJsonSha256(backtest.manifest);
  const eventPayloadSha256 = canonicalJsonSha256({
    backtestId: backtest.id,
    snapshotSha256: backtest.snapshotSha256,
    manifestSha256,
    resultSha256: backtest.resultSha256,
  });
  const inserted = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const rows = await sql`
      INSERT INTO omni_market_backtests (
        schema_version, id, tenant_id, owner_actor_id, contract_version,
        backtest_version, instrument_id, provider, provider_symbol, interval,
        snapshot_id, snapshot_sha256, snapshot_as_of, strategy_id,
        engine_rules_sha256, manifest_sha256, result_sha256, backtest, created_at
      ) VALUES (
        1, ${backtest.id}, ${input.tenantId}, ${input.actorId},
        ${backtest.contractVersion}, ${backtest.backtestVersion},
        ${backtest.instrumentId}, ${backtest.provider}, ${backtest.providerSymbol},
        ${backtest.interval}, ${backtest.snapshotId}, ${backtest.snapshotSha256},
        ${backtest.snapshotAsOf}, ${backtest.manifest.strategy.strategyId},
        ${backtest.manifest.engineRulesSha256}, ${manifestSha256},
        ${backtest.resultSha256}, ${backtest}::JSONB, ${backtest.createdAt}
      )
      ON CONFLICT (tenant_id, owner_actor_id, snapshot_id, manifest_sha256)
      DO NOTHING
      RETURNING id
    `;
    if (rows[0]) {
      await sql`
        INSERT INTO omni_market_backtest_events (
          schema_version, id, tenant_id, owner_actor_id, backtest_id,
          event_type, operation_job_id, payload_sha256, occurred_at
        ) VALUES (
          1, ${eventId(input.operationJobId, backtest.id)}, ${input.tenantId},
          ${input.actorId}, ${backtest.id}, 'market.backtest.completed',
          ${input.operationJobId}, ${eventPayloadSha256}, ${backtest.createdAt}
        )
        ON CONFLICT (tenant_id, id) DO NOTHING
      `;
    }
    return Boolean(rows[0]);
  }) as boolean;
  const rows = await getSql()`
    SELECT backtest
    FROM omni_market_backtests
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND snapshot_id = ${backtest.snapshotId}
      AND manifest_sha256 = ${manifestSha256}
    LIMIT 1
  `;
  if (!rows[0]) throw new Error("The immutable market backtest could not be read back.");
  return { inserted, backtest: marketBacktestFromRow(rows[0]) };
}

export async function listMarketBacktests(input: {
  tenantId: string;
  actorId: string;
  instrumentId: MarketInstrumentId;
  limit: number;
}): Promise<MarketBacktestsResult> {
  assertOwnerScope(input.tenantId, input.actorId);
  if (!hasDatabaseUrl()) {
    return marketBacktestsResultSchema.parse({
      contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
      instrumentId: input.instrumentId,
      backtests: [],
      total: 0,
    });
  }
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT backtest
    FROM omni_market_backtests
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND instrument_id = ${input.instrumentId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${input.limit}
  `;
  const totals = await getSql()`
    SELECT COUNT(*)::INTEGER AS total
    FROM omni_market_backtests
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND instrument_id = ${input.instrumentId}
  `;
  return marketBacktestsResultSchema.parse({
    contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
    instrumentId: input.instrumentId,
    backtests: rows.map(marketBacktestFromRow),
    total: Number(totals[0]?.total || 0),
  });
}

function marketBacktestFromRow(row: Record<string, unknown>) {
  const value = typeof row.backtest === "string"
    ? JSON.parse(row.backtest)
    : row.backtest;
  return marketBacktestSchema.parse(value);
}

function eventId(operationJobId: string, backtestId: string) {
  return `market_backtest_event_${digest(`${operationJobId}:${backtestId}`)}`;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 48);
}

function assertOwnerScope(tenantId: string, actorId: string) {
  if (!tenantId.trim() || !actorId.trim()) {
    throw new Error("Market backtests require explicit tenant and actor scope.");
  }
}
