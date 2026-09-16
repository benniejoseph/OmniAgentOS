import { describe, expect, it } from "vitest";

import {
  buildDeterministicMarketBacktest,
  MarketBacktestInsufficientDataError,
} from "@/lib/market-research/backtest-engine";
import type {
  MarketBacktestRequest,
  MarketBar,
  MarketBarsResult,
} from "@/lib/market-research/contracts";

describe("deterministic market backtest", () => {
  it("enters after a reviewed foundation signal and seals reproducible lineage", () => {
    const first = buildDeterministicMarketBacktest({
      tenantId: "tenant_test",
      actorId: "actor_test",
      snapshot: snapshotWithLongTarget(),
      request: request(),
      createdAt: "2026-09-16T10:00:00.000Z",
    });
    const second = buildDeterministicMarketBacktest({
      tenantId: "tenant_test",
      actorId: "actor_test",
      snapshot: structuredClone(snapshotWithLongTarget()),
      request: structuredClone(request()),
      createdAt: "2026-09-16T11:00:00.000Z",
    });

    expect(first.trades).toHaveLength(1);
    expect(first.trades[0]).toMatchObject({
      direction: "long",
      exitReason: "target",
      split: "train",
    });
    expect(Date.parse(first.trades[0].enteredAt)).toBeGreaterThan(
      Date.parse(first.trades[0].signalAt),
    );
    expect(first.trades[0].netR).toBeLessThan(first.trades[0].grossR);
    expect(first.leakageChecks).toEqual({
      strictChronology: true,
      immutableSnapshotBound: true,
      signalUsesPastAndPresentOnly: true,
      entryAfterSignal: true,
      costsApplied: true,
    });
    expect(first.manifest.evaluationLabel).toBe("retrospective_rule_evaluation");
    expect(first.manifest.engineRulesSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.id).toBe(first.id);
    expect(second.resultSha256).toBe(first.resultSha256);
    expect(second.trades).toEqual(first.trades);
  });

  it("uses the conservative stop-first policy when one bar crosses both exits", () => {
    const value = snapshotWithLongTarget();
    const start = Date.parse(value.bars[0].timestamp);
    value.bars[20] = bar(start, 20, 100, 102, 99.5, 100);
    value.bars[21] = bar(start, 21, 100, 103, 95, 99);

    const result = buildDeterministicMarketBacktest({
      tenantId: "tenant_test",
      actorId: "actor_test",
      snapshot: value,
      request: {
        ...request(),
        strategy: { ...request().strategy, direction: "short_only" },
      },
      createdAt: "2026-09-16T10:00:00.000Z",
    });

    expect(result.trades[0]).toMatchObject({
      direction: "short",
      exitReason: "stop",
      grossR: -1,
    });
    expect(result.metrics.overall.losses).toBe(1);
  });

  it("fails closed for insufficient or duplicate bars", () => {
    const tooSmall = snapshotWithLongTarget();
    tooSmall.bars = tooSmall.bars.slice(0, 21);
    expect(() => buildDeterministicMarketBacktest({
      tenantId: "tenant_test",
      actorId: "actor_test",
      snapshot: tooSmall,
      request: request(),
    })).toThrow(MarketBacktestInsufficientDataError);

    const duplicate = snapshotWithLongTarget();
    duplicate.bars[22] = { ...duplicate.bars[22], time: duplicate.bars[21].time };
    expect(() => buildDeterministicMarketBacktest({
      tenantId: "tenant_test",
      actorId: "actor_test",
      snapshot: duplicate,
      request: request(),
    })).toThrow(/strictly increasing/i);
  });
});

function request(): MarketBacktestRequest {
  return {
    snapshotId: `market_snapshot_${"a".repeat(48)}`,
    strategy: {
      strategyId: "foundation.liquidity_sweep_reversal.v1",
      direction: "both",
      session: "all",
      rewardRiskRatio: 2,
      maxHoldingBars: 24,
      stopBufferRangeMultiplier: 0.1,
    },
    costs: {
      spreadBps: 2,
      slippageBps: 1,
      commissionBps: 0,
    },
    initialEquity: 10_000,
    riskPerTradeBps: 100,
  };
}

function snapshotWithLongTarget(): MarketBarsResult {
  const start = Date.parse("2026-09-14T00:00:00.000Z");
  const bars = Array.from({ length: 100 }, (_, index) =>
    bar(start, index, 100, 100.5, 99.5, 100)
  );
  bars[20] = bar(start, 20, 100, 100.25, 98, 100);
  bars[21] = bar(start, 21, 100, 100.4, 99.6, 100.1);
  bars[22] = bar(start, 22, 100.1, 105, 99.9, 104.5);
  return {
    contractVersion: "market-research-foundation:6",
    instrumentId: "xauusd.spot",
    provider: "twelve_data",
    providerSymbol: "XAU/USD",
    providerTimezone: "UTC",
    interval: "5min",
    retrievedAt: "2026-09-14T09:00:00.000Z",
    asOf: bars.at(-1)!.timestamp,
    bars,
    snapshotId: `market_snapshot_${"a".repeat(48)}`,
    snapshotSha256: "b".repeat(64),
    snapshotSource: "provider",
  };
}

function bar(
  start: number,
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
): MarketBar {
  const time = start + index * 5 * 60_000;
  return {
    time: Math.floor(time / 1_000),
    timestamp: new Date(time).toISOString(),
    open,
    high,
    low,
    close,
    volume: null,
  };
}
