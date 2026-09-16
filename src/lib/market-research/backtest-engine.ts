import { createHash } from "node:crypto";

import {
  MARKET_BACKTEST_VERSION,
  MARKET_RESEARCH_CONTRACT_VERSION,
  marketBacktestRequestSchema,
  marketBacktestSchema,
  marketBarsResultSchema,
  type MarketBacktest,
  type MarketBacktestRequest,
  type MarketBar,
  type MarketBarsResult,
} from "@/lib/market-research/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const LOOKBACK_BARS = 20;
const MINIMUM_STOP_RANGE_MULTIPLIER = 0.25;
const SPLIT_RATIOS = [0.6, 0.2, 0.2] as const;
const ENGINE_RULES = Object.freeze({
  version: MARKET_BACKTEST_VERSION,
  strategy: "foundation.liquidity_sweep_reversal.v1",
  signal: "trade beyond the exact prior 20-bar boundary and close back inside",
  entry: "next bar open",
  stop: "signal extreme plus configured prior-median-range buffer",
  minimumStop: "0.25 times the prior 20-bar median range",
  target: "configured reward/risk multiple from entry",
  collision: "stop before target when both trade in one bar",
  overlap: "one position at a time",
  splits: SPLIT_RATIOS,
});

type Trade = MarketBacktest["trades"][number];
type Split = Trade["split"];

export class MarketBacktestInsufficientDataError extends Error {
  constructor() {
    super("At least 22 strictly ordered immutable bars are required for backtesting.");
    this.name = "MarketBacktestInsufficientDataError";
  }
}

export function buildDeterministicMarketBacktest(input: {
  tenantId: string;
  actorId: string;
  snapshot: MarketBarsResult;
  request: MarketBacktestRequest;
  createdAt?: string;
}): MarketBacktest {
  assertOwnerScope(input.tenantId, input.actorId);
  const snapshot = marketBarsResultSchema.parse(input.snapshot);
  const request = marketBacktestRequestSchema.parse(input.request);
  if (request.snapshotId !== snapshot.snapshotId) {
    throw new Error("Backtest request does not match the immutable snapshot.");
  }
  const bars = [...snapshot.bars].sort((left, right) => left.time - right.time);
  if (bars.length < LOOKBACK_BARS + 2) {
    throw new MarketBacktestInsufficientDataError();
  }
  assertStrictChronology(bars);

  const validationIndex = Math.max(LOOKBACK_BARS + 1, Math.floor(bars.length * 0.6));
  const testIndex = Math.max(validationIndex + 1, Math.floor(bars.length * 0.8));
  const splitBoundaries = {
    validationStartsAt: bars[Math.min(validationIndex, bars.length - 2)].timestamp,
    testStartsAt: bars[Math.min(testIndex, bars.length - 1)].timestamp,
  };
  const manifest = {
    strategy: request.strategy,
    costs: request.costs,
    initialEquity: request.initialEquity,
    riskPerTradeBps: request.riskPerTradeBps,
    engineRulesSha256: canonicalJsonSha256(ENGINE_RULES),
    entryTiming: "next_bar_open" as const,
    collisionPolicy: "stop_first" as const,
    overlapPolicy: "single_position" as const,
    evaluationLabel: "retrospective_rule_evaluation" as const,
    splitRatios: SPLIT_RATIOS,
  };
  const backtestId = `market_backtest_${digest(canonicalJsonSha256({
    tenantId: input.tenantId,
    actorId: input.actorId,
    snapshotId: snapshot.snapshotId,
    snapshotSha256: snapshot.snapshotSha256,
    manifest,
  }))}`;
  const trades = runStrategy({
    backtestId,
    bars,
    request,
    validationIndex,
    testIndex,
  });
  const metrics = {
    overall: buildMetrics(trades, request),
    train: buildMetrics(trades.filter((trade) => trade.split === "train"), request),
    validation: buildMetrics(
      trades.filter((trade) => trade.split === "validation"),
      request,
    ),
    test: buildMetrics(trades.filter((trade) => trade.split === "test"), request),
  };
  const warnings = buildWarnings(metrics);
  const stableBody = {
    contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
    backtestVersion: MARKET_BACKTEST_VERSION,
    id: backtestId,
    instrumentId: snapshot.instrumentId,
    provider: snapshot.provider,
    providerSymbol: snapshot.providerSymbol,
    interval: snapshot.interval,
    snapshotId: snapshot.snapshotId,
    snapshotSha256: snapshot.snapshotSha256,
    snapshotAsOf: snapshot.asOf,
    firstBarAt: bars[0].timestamp,
    lastBarAt: bars.at(-1)!.timestamp,
    barCount: bars.length,
    manifest,
    splitBoundaries,
    leakageChecks: {
      strictChronology: true as const,
      immutableSnapshotBound: true as const,
      signalUsesPastAndPresentOnly: true as const,
      entryAfterSignal: true as const,
      costsApplied: true as const,
    },
    metrics,
    trades,
    warnings,
  };
  return marketBacktestSchema.parse({
    ...stableBody,
    resultSha256: canonicalJsonSha256(stableBody),
    createdAt: input.createdAt || new Date().toISOString(),
  });
}

function runStrategy(input: {
  backtestId: string;
  bars: MarketBar[];
  request: MarketBacktestRequest;
  validationIndex: number;
  testIndex: number;
}) {
  const trades: Trade[] = [];
  let equity = input.request.initialEquity;
  let signalIndex = LOOKBACK_BARS;
  while (signalIndex < input.bars.length - 1) {
    const signal = detectSignal(
      input.bars,
      signalIndex,
      input.request.strategy.direction,
      input.request.strategy.session,
    );
    if (!signal) {
      signalIndex += 1;
      continue;
    }
    const lookback = input.bars.slice(signalIndex - LOOKBACK_BARS, signalIndex);
    const medianRange = median(lookback.map((bar) => bar.high - bar.low));
    const entryIndex = signalIndex + 1;
    const entryBar = input.bars[entryIndex];
    if (medianRange <= 0 || entryBar.open <= 0) {
      signalIndex += 1;
      continue;
    }
    const buffer = medianRange * input.request.strategy.stopBufferRangeMultiplier;
    const rawStop = signal.direction === "long"
      ? input.bars[signalIndex].low - buffer
      : input.bars[signalIndex].high + buffer;
    const minimumStopDistance = medianRange * MINIMUM_STOP_RANGE_MULTIPLIER;
    const stopDistance = Math.max(
      signal.direction === "long" ? entryBar.open - rawStop : rawStop - entryBar.open,
      minimumStopDistance,
    );
    const stopPrice = signal.direction === "long"
      ? entryBar.open - stopDistance
      : entryBar.open + stopDistance;
    const targetPrice = signal.direction === "long"
      ? entryBar.open + stopDistance * input.request.strategy.rewardRiskRatio
      : entryBar.open - stopDistance * input.request.strategy.rewardRiskRatio;
    if (stopPrice <= 0 || targetPrice <= 0) {
      signalIndex += 1;
      continue;
    }
    const exit = resolveExit({
      bars: input.bars,
      entryIndex,
      direction: signal.direction,
      stopPrice,
      targetPrice,
      maxHoldingBars: input.request.strategy.maxHoldingBars,
    });
    const directionalMove = signal.direction === "long"
      ? exit.price - entryBar.open
      : entryBar.open - exit.price;
    const grossR = directionalMove / stopDistance;
    const roundTripCostBps = input.request.costs.spreadBps
      + 2 * input.request.costs.slippageBps
      + 2 * input.request.costs.commissionBps;
    const stopDistanceBps = stopDistance / entryBar.open * 10_000;
    const netR = grossR - roundTripCostBps / stopDistanceBps;
    const riskAmount = equity * input.request.riskPerTradeBps / 10_000;
    equity = Math.max(0, equity + riskAmount * netR);
    trades.push({
      id: `market_backtest_trade_${digest(`${input.backtestId}:${signalIndex}:${exit.index}`)}`,
      split: splitForIndex(entryIndex, input.validationIndex, input.testIndex),
      direction: signal.direction,
      signalAt: input.bars[signalIndex].timestamp,
      enteredAt: entryBar.timestamp,
      exitedAt: input.bars[exit.index].timestamp,
      entryPrice: round(entryBar.open),
      exitPrice: round(exit.price),
      stopPrice: round(stopPrice),
      targetPrice: round(targetPrice),
      exitReason: exit.reason,
      holdingBars: exit.index - entryIndex + 1,
      grossR: round(grossR),
      netR: round(netR),
      equityAfter: round(equity),
    });
    signalIndex = exit.index + 1;
  }
  return trades;
}

function detectSignal(
  bars: MarketBar[],
  index: number,
  directionMode: MarketBacktestRequest["strategy"]["direction"],
  session: MarketBacktestRequest["strategy"]["session"],
) {
  const bar = bars[index];
  if (!sessionAllows(bar.timestamp, session)) return null;
  const lookback = bars.slice(index - LOOKBACK_BARS, index);
  const priorHigh = Math.max(...lookback.map((candidate) => candidate.high));
  const priorLow = Math.min(...lookback.map((candidate) => candidate.low));
  if (
    directionMode !== "short_only" &&
    bar.low < priorLow &&
    bar.close > priorLow
  ) {
    return { direction: "long" as const };
  }
  if (
    directionMode !== "long_only" &&
    bar.high > priorHigh &&
    bar.close < priorHigh
  ) {
    return { direction: "short" as const };
  }
  return null;
}

function resolveExit(input: {
  bars: MarketBar[];
  entryIndex: number;
  direction: "long" | "short";
  stopPrice: number;
  targetPrice: number;
  maxHoldingBars: number;
}) {
  const finalIndex = Math.min(
    input.bars.length - 1,
    input.entryIndex + input.maxHoldingBars - 1,
  );
  for (let index = input.entryIndex; index <= finalIndex; index += 1) {
    const bar = input.bars[index];
    if (input.direction === "long") {
      if (bar.open <= input.stopPrice) return exit(index, bar.open, "stop");
      if (bar.open >= input.targetPrice) return exit(index, bar.open, "target");
      if (bar.low <= input.stopPrice) return exit(index, input.stopPrice, "stop");
      if (bar.high >= input.targetPrice) return exit(index, input.targetPrice, "target");
    } else {
      if (bar.open >= input.stopPrice) return exit(index, bar.open, "stop");
      if (bar.open <= input.targetPrice) return exit(index, bar.open, "target");
      if (bar.high >= input.stopPrice) return exit(index, input.stopPrice, "stop");
      if (bar.low <= input.targetPrice) return exit(index, input.targetPrice, "target");
    }
  }
  const bar = input.bars[finalIndex];
  return exit(
    finalIndex,
    bar.close,
    finalIndex === input.bars.length - 1 ? "snapshot_end" : "timeout",
  );
}

function exit(
  index: number,
  price: number,
  reason: Trade["exitReason"],
) {
  return { index, price, reason };
}

function buildMetrics(trades: Trade[], request: MarketBacktestRequest) {
  const wins = trades.filter((trade) => trade.netR > 0).length;
  const losses = trades.filter((trade) => trade.netR < 0).length;
  const breakEven = trades.length - wins - losses;
  const netR = trades.reduce((sum, trade) => sum + trade.netR, 0);
  const grossProfit = trades.reduce(
    (sum, trade) => sum + Math.max(0, trade.netR),
    0,
  );
  const grossLoss = Math.abs(trades.reduce(
    (sum, trade) => sum + Math.min(0, trade.netR),
    0,
  ));
  let equity = request.initialEquity;
  let peak = equity;
  let maxDrawdownPercent = 0;
  for (const trade of trades) {
    const riskAmount = equity * request.riskPerTradeBps / 10_000;
    equity = Math.max(0, equity + riskAmount * trade.netR);
    peak = Math.max(peak, equity);
    const drawdown = peak <= 0 ? 0 : (peak - equity) / peak * 100;
    maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdown);
  }
  return {
    trades: trades.length,
    wins,
    losses,
    breakEven,
    winRate: trades.length ? round(wins / trades.length) : null,
    netR: round(netR),
    expectancyR: trades.length ? round(netR / trades.length) : null,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    maxDrawdownPercent: round(maxDrawdownPercent),
    endingEquity: round(equity),
  };
}

function buildWarnings(metrics: MarketBacktest["metrics"]) {
  const warnings: string[] = [];
  if (!metrics.overall.trades) {
    warnings.push("No qualifying liquidity-sweep trades occurred in this snapshot.");
  } else if (metrics.overall.trades < 30) {
    warnings.push("Fewer than 30 trades: the result is descriptive, not reliable evidence of an edge.");
  }
  if (metrics.test.trades < 10) {
    warnings.push("The held-out test slice has fewer than 10 trades and is not decision-grade.");
  }
  warnings.push("Hypothetical retrospective result; it is not a calibrated forecast or trading advice.");
  return warnings;
}

function splitForIndex(index: number, validationIndex: number, testIndex: number): Split {
  if (index >= testIndex) return "test";
  if (index >= validationIndex) return "validation";
  return "train";
}

function sessionAllows(
  timestamp: string,
  session: MarketBacktestRequest["strategy"]["session"],
) {
  if (session === "all") return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  const localMinutes = hour * 60 + minute;
  return session === "london"
    ? localMinutes >= 2 * 60 && localMinutes < 5 * 60
    : localMinutes >= 7 * 60 && localMinutes < 10 * 60;
}

function assertStrictChronology(bars: MarketBar[]) {
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].time <= bars[index - 1].time) {
      throw new Error("Backtest bars must have unique, strictly increasing timestamps.");
    }
  }
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 48);
}

function assertOwnerScope(tenantId: string, actorId: string) {
  if (!tenantId.trim() || !actorId.trim()) {
    throw new Error("Market backtests require explicit tenant and actor scope.");
  }
}
