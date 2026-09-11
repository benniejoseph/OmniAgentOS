import "server-only";

import { createHash } from "node:crypto";

import {
  MARKET_FORWARD_SHADOW_VERSION,
  marketForecastJournalResultSchema,
  marketForecastOutcomeSchema,
  marketForwardForecastSchema,
  type MarketForecastHorizon,
  type MarketForecastJournalResult,
  type MarketForecastOutcome,
  type MarketForwardForecast,
  type MarketInstrumentId,
} from "@/lib/market-research/contracts";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  assertExecutionScopeTenant,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export async function findMarketForecastForWindow(input: {
  tenantId: string;
  actorId: string;
  instrumentId: MarketInstrumentId;
  horizon: MarketForecastHorizon;
  windowStart: string;
}): Promise<MarketForwardForecast | null> {
  assertOwner(input.tenantId, input.actorId);
  if (!hasDatabaseUrl()) return null;
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT forecast
    FROM omni_market_forward_forecasts
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.actorId}
      AND instrument_id = ${input.instrumentId}
      AND horizon = ${input.horizon}
      AND window_start = ${input.windowStart}::TIMESTAMPTZ
    LIMIT 1
  `;
  return rows[0] ? marketForwardForecastSchema.parse(rows[0].forecast) : null;
}

export async function saveMarketForwardForecast(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  idempotencyKey: string;
  forecast: MarketForwardForecast;
}): Promise<{ inserted: boolean; forecast: MarketForwardForecast }> {
  assertMutationScope(input);
  if (!hasDatabaseUrl()) {
    throw new Error("A durable database is required to seal a market forecast.");
  }
  const forecast = marketForwardForecastSchema.parse(input.forecast);
  await ensureDatabaseSchema();
  const idempotencyKeySha256 = sha256(input.idempotencyKey);
  const eventPayloadSha256 = canonicalJsonSha256({
    forecastId: forecast.id,
    forecastSha256: forecast.forecastSha256,
    snapshotSha256: forecast.evidence.snapshotSha256,
    assignmentConfigurationSha256:
      forecast.modelAttribution.assignmentConfigurationSha256,
  });
  const inserted = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const rows = await sql`
      INSERT INTO omni_market_forward_forecasts (
        schema_version, id, tenant_id, owner_actor_id, contract_version,
        instrument_id, horizon, window_start, window_end, sealed_at,
        probability_state, forecast_sha256, forecast, snapshot_id,
        snapshot_sha256, technical_result_sha256, baseline_result_sha256,
        model_provider, model_id, assignment_id, assignment_revision,
        assignment_configuration_sha256, usage_receipt_id, created_at
      ) VALUES (
        1, ${forecast.id}, ${input.tenantId}, ${input.actorId},
        ${MARKET_FORWARD_SHADOW_VERSION}, ${forecast.instrumentId},
        ${forecast.horizon}, ${forecast.windowStart}, ${forecast.windowEnd},
        ${forecast.sealedAt}, ${forecast.probabilityState},
        ${forecast.forecastSha256}, ${forecast}::JSONB,
        ${forecast.evidence.snapshotId}, ${forecast.evidence.snapshotSha256},
        ${forecast.evidence.technicalResultSha256},
        ${forecast.evidence.baselineResultSha256},
        ${forecast.modelAttribution.provider}, ${forecast.modelAttribution.model},
        ${forecast.modelAttribution.assignmentId},
        ${forecast.modelAttribution.assignmentRevision},
        ${forecast.modelAttribution.assignmentConfigurationSha256},
        ${forecast.modelAttribution.usageReceiptId}::UUID, NOW()
      )
      ON CONFLICT (
        tenant_id, owner_actor_id, instrument_id, horizon, window_start
      ) DO NOTHING
      RETURNING id
    `;
    if (rows[0]) {
      await sql`
        INSERT INTO omni_market_forecast_events (
          schema_version, id, tenant_id, owner_actor_id, forecast_id,
          event_type, idempotency_key_sha256, payload_sha256, occurred_at
        ) VALUES (
          1, ${ledgerId(forecast.id, "sealed", idempotencyKeySha256)},
          ${input.tenantId}, ${input.actorId}, ${forecast.id},
          'market.forward_forecast.sealed', ${idempotencyKeySha256},
          ${eventPayloadSha256}, NOW()
        )
        ON CONFLICT (tenant_id, id) DO NOTHING
      `;
    }
    return Boolean(rows[0]);
  }) as boolean;
  if (inserted) return { inserted, forecast };
  const existing = await findMarketForecastForWindow({
    tenantId: input.tenantId,
    actorId: input.actorId,
    instrumentId: forecast.instrumentId,
    horizon: forecast.horizon,
    windowStart: forecast.windowStart,
  });
  if (!existing) {
    throw new Error("The sealed market forecast could not be reconciled.");
  }
  return { inserted: false, forecast: existing };
}

export async function listMarketForecastJournal(input: {
  tenantId: string;
  actorId: string;
  instrumentId: MarketInstrumentId;
  limit: number;
  now?: string;
}): Promise<MarketForecastJournalResult> {
  assertOwner(input.tenantId, input.actorId);
  if (!hasDatabaseUrl()) return emptyJournal(input.instrumentId);
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT forecast.forecast, outcome.outcome
    FROM omni_market_forward_forecasts forecast
    LEFT JOIN omni_market_forecast_outcomes outcome
      ON outcome.tenant_id = forecast.tenant_id
      AND outcome.owner_actor_id = forecast.owner_actor_id
      AND outcome.forecast_id = forecast.id
    WHERE forecast.tenant_id = ${input.tenantId}
      AND forecast.owner_actor_id = ${input.actorId}
      AND forecast.instrument_id = ${input.instrumentId}
    ORDER BY forecast.window_start DESC, forecast.id DESC
    LIMIT ${input.limit}
  `;
  const now = Date.parse(input.now || new Date().toISOString());
  const entries = rows.map((row) => {
    const forecast = marketForwardForecastSchema.parse(row.forecast);
    const outcome = row.outcome
      ? marketForecastOutcomeSchema.parse(row.outcome)
      : null;
    return {
      forecast,
      resolutionState: outcome
        ? "resolved" as const
        : Date.parse(forecast.windowEnd) <= now
          ? "due" as const
          : "open" as const,
      outcome,
    };
  });
  const resolved = entries.filter((entry) => entry.outcome);
  const directional = resolved.filter((entry) =>
    entry.forecast.stance !== "abstain"
  );
  const correct = directional.filter((entry) => entry.outcome?.stanceHit === true);
  return marketForecastJournalResultSchema.parse({
    contractVersion: MARKET_FORWARD_SHADOW_VERSION,
    instrumentId: input.instrumentId,
    entries,
    scorecard: {
      total: entries.length,
      resolved: resolved.length,
      due: entries.filter((entry) => entry.resolutionState === "due").length,
      abstentions: entries.filter((entry) => entry.forecast.stance === "abstain").length,
      directionalAccuracy: directional.length
        ? correct.length / directional.length
        : null,
      directionalSampleSize: directional.length,
      coverage: resolved.length ? directional.length / resolved.length : null,
      brierScore: null,
      probabilityState: "uncalibrated",
    },
  });
}

export async function listDueMarketForecasts(input: {
  tenantId: string;
  actorId: string;
  instrumentId: MarketInstrumentId;
  limit: number;
}): Promise<MarketForwardForecast[]> {
  assertOwner(input.tenantId, input.actorId);
  if (!hasDatabaseUrl()) return [];
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT forecast.forecast
    FROM omni_market_forward_forecasts forecast
    WHERE forecast.tenant_id = ${input.tenantId}
      AND forecast.owner_actor_id = ${input.actorId}
      AND forecast.instrument_id = ${input.instrumentId}
      AND forecast.window_end <= NOW()
      AND NOT EXISTS (
        SELECT 1 FROM omni_market_forecast_outcomes outcome
        WHERE outcome.tenant_id = forecast.tenant_id
          AND outcome.owner_actor_id = forecast.owner_actor_id
          AND outcome.forecast_id = forecast.id
      )
    ORDER BY forecast.window_end ASC, forecast.id ASC
    LIMIT ${input.limit}
  `;
  return rows.map((row) => marketForwardForecastSchema.parse(row.forecast));
}

export async function saveMarketForecastOutcome(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  idempotencyKey: string;
  outcome: MarketForecastOutcome;
}) {
  assertMutationScope(input);
  if (!hasDatabaseUrl()) {
    throw new Error("A durable database is required to resolve a market forecast.");
  }
  const outcome = marketForecastOutcomeSchema.parse(input.outcome);
  await ensureDatabaseSchema();
  const idempotencyKeySha256 = sha256(input.idempotencyKey);
  const inserted = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const parent = await sql`
      SELECT id
      FROM omni_market_forward_forecasts
      WHERE tenant_id = ${input.tenantId}
        AND owner_actor_id = ${input.actorId}
        AND id = ${outcome.forecastId}
      LIMIT 1
    `;
    if (!parent[0]) throw new Error("The market forecast outcome parent is unavailable.");
    const rows = await sql`
      INSERT INTO omni_market_forecast_outcomes (
        schema_version, id, tenant_id, owner_actor_id, forecast_id,
        outcome_sha256, source_payload_sha256, snapshot_sha256, outcome,
        resolved_at, created_at
      ) VALUES (
        1, ${outcome.id}, ${input.tenantId}, ${input.actorId},
        ${outcome.forecastId}, ${outcome.outcomeSha256},
        ${outcome.sourcePayloadSha256}, ${outcome.snapshotSha256},
        ${outcome}::JSONB, ${outcome.resolvedAt}, NOW()
      )
      ON CONFLICT (tenant_id, owner_actor_id, forecast_id) DO NOTHING
      RETURNING id
    `;
    if (rows[0]) {
      await sql`
        INSERT INTO omni_market_forecast_events (
          schema_version, id, tenant_id, owner_actor_id, forecast_id,
          event_type, idempotency_key_sha256, payload_sha256, occurred_at
        ) VALUES (
          1, ${ledgerId(outcome.forecastId, "resolved", idempotencyKeySha256)},
          ${input.tenantId}, ${input.actorId}, ${outcome.forecastId},
          'market.forward_forecast.resolved', ${idempotencyKeySha256},
          ${outcome.outcomeSha256}, NOW()
        )
        ON CONFLICT (tenant_id, id) DO NOTHING
      `;
    }
    return Boolean(rows[0]);
  }) as boolean;
  return { inserted, outcome };
}

function emptyJournal(instrumentId: MarketInstrumentId) {
  return marketForecastJournalResultSchema.parse({
    contractVersion: MARKET_FORWARD_SHADOW_VERSION,
    instrumentId,
    entries: [],
    scorecard: {
      total: 0,
      resolved: 0,
      due: 0,
      abstentions: 0,
      directionalAccuracy: null,
      directionalSampleSize: 0,
      coverage: null,
      brierScore: null,
      probabilityState: "uncalibrated",
    },
  });
}

function assertMutationScope(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  idempotencyKey: string;
}) {
  assertOwner(input.tenantId, input.actorId);
  assertExecutionScopeTenant(input.executionScope, input.tenantId);
  if (
    input.executionScope.initiatingActorId !== input.actorId ||
    !input.idempotencyKey.trim()
  ) {
    throw new Error("Market forecast mutation scope is invalid.");
  }
}

function assertOwner(tenantId: string, actorId: string) {
  if (!tenantId.trim() || !actorId.trim()) {
    throw new Error("Market forecast access requires an exact tenant and actor.");
  }
}

function ledgerId(forecastId: string, kind: string, idempotencyKeySha256: string) {
  return `market_forecast_ledger_${digest({ forecastId, kind, idempotencyKeySha256 })}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 48);
}
