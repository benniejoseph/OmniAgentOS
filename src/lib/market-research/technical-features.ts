import { createHash } from "node:crypto";

import {
  MARKET_RESEARCH_CONTRACT_VERSION,
  MARKET_TECHNICAL_DETECTOR_VERSION,
  marketBarsResultSchema,
  marketTechnicalFeaturesResultSchema,
  type MarketBar,
  type MarketBarsResult,
  type MarketTechnicalFeaturesResult,
} from "@/lib/market-research/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const NEW_YORK_TIMEZONE = "America/New_York" as const;
const RANGE_LOOKBACK = 96;
const MAX_DETECTIONS = 240;
const MAX_ANNOTATIONS = 120;

type LocalParts = {
  date: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};
type Detection = MarketTechnicalFeaturesResult["detections"][number];
type Annotation = MarketTechnicalFeaturesResult["annotations"][number];
type LayerId = MarketTechnicalFeaturesResult["layers"][number]["id"];

const sessionWindows = [
  { id: "asia", label: "Asia session", start: 20 * 60, end: 24 * 60 },
  { id: "london", label: "London kill zone", start: 2 * 60, end: 5 * 60 },
  { id: "new_york", label: "New York kill zone", start: 7 * 60, end: 10 * 60 },
  { id: "new_york_pm", label: "New York PM", start: 13 * 60 + 30, end: 16 * 60 },
] as const;

export class MarketTechnicalInsufficientDataError extends Error {
  constructor() {
    super("At least five immutable market bars are required for technical features.");
    this.name = "MarketTechnicalInsufficientDataError";
  }
}

const definitions: MarketTechnicalFeaturesResult["definitions"] = [
  definition("foundation.swing.v2", "Five-bar swing", "A swing high is strictly higher than the two bars on each side; a swing low is strictly lower. Equal neighbors do not qualify."),
  definition("foundation.fvg.v2", "Three-bar fair value gap", "Bullish when bar three's low is above bar one's high; bearish when bar three's high is below bar one's low. A first touch is partial; traversal of the far edge is mitigated."),
  definition("foundation.displacement.v1", "Range-relative displacement", "Candle body is at least 1.5 times the median range of the prior 20 bars and closes within the directional outer quarter of its own range."),
  definition("foundation.liquidity_sweep.v1", "Boundary liquidity sweep", "Price trades beyond the exact prior 20-bar high or low and closes back inside that boundary on the same bar."),
  definition("foundation.liquidity_pool.v1", "Equal-high / equal-low liquidity", "Two same-side five-bar swings at least three bars apart qualify when their prices differ by no more than 0.12 times the recent 20-bar median range."),
  definition("foundation.session_window.v1", "New York-time session windows", "Observed bars are grouped into Asia 20:00–24:00, London 02:00–05:00, New York 07:00–10:00, and New York PM 13:30–16:00 windows in America/New_York."),
  definition("foundation.calendar_gap.v1", "Daily opening gap", "At a New York calendar-date change, the new open and prior close form a gap when their distance is at least 0.20 times the prior 20-bar median range."),
  definition("foundation.quarterly_time.v1", "Ninety-minute time quarter", "New York calendar days are divided from midnight into sixteen fixed 90-minute quarters; a quarter is drawn only where its first bar exists in the immutable snapshot."),
  definition("candidate.order_block.v1", "Order-block candidate", "The latest opposite candle within five bars before a displacement qualifies only when a same-direction fair value gap forms within two bars. A later close beyond its distal edge invalidates it.", true),
  definition("candidate.market_structure_shift.v1", "Market-structure-shift candidate", "After a same-bar liquidity sweep, price must close through the latest opposite five-bar swing within six bars with a range-relative directional expansion.", true),
  definition("candidate.turtle_soup.v1", "Turtle Soup candidate", "A 20-bar liquidity sweep that closes back inside its boundary during one configured New York-time session window is marked as a candidate reversal setup.", true),
  definition("candidate.unicorn.v1", "Unicorn candidate", "An invalidated order-block candidate and a later opposite-direction fair value gap must overlap in price within eight bars of invalidation.", true),
  definition("candidate.judas_swing.v1", "Judas Swing candidate", "A Turtle Soup candidate in the first hour of the London or New York window must be followed within six bars by displacement in the reversal direction.", true),
];

function definition(
  id: Detection["definitionId"],
  label: string,
  formula: string,
  candidate = false,
): MarketTechnicalFeaturesResult["definitions"][number] {
  return {
    id,
    label,
    formula,
    reviewState: candidate ? "candidate_rule" : "deterministic_foundation",
    transcriptAuthority: candidate ? "awaiting_review" : "not_claimed",
  };
}

export function buildMarketTechnicalFeatures(
  input: MarketBarsResult,
): MarketTechnicalFeaturesResult {
  const snapshot = marketBarsResultSchema.parse(input);
  const bars = [...snapshot.bars].sort((left, right) => left.time - right.time);
  if (bars.length < 5) throw new MarketTechnicalInsufficientDataError();
  assertStrictChronology(bars);

  const swings = detectSwings(snapshot.snapshotSha256, bars);
  const fairValueGaps = detectFairValueGaps(snapshot.snapshotSha256, bars);
  const displacements = detectDisplacements(snapshot.snapshotSha256, bars);
  const sweeps = detectLiquiditySweeps(snapshot.snapshotSha256, bars);
  const liquidity = detectLiquidityPools(snapshot.snapshotSha256, bars, swings);
  const sessions = detectSessionWindows(snapshot.snapshotSha256, bars);
  const gaps = detectOpeningGaps(snapshot.snapshotSha256, bars);
  const quarters = detectQuarterOpens(snapshot.snapshotSha256, bars);
  const blocks = detectOrderBlocks(snapshot.snapshotSha256, bars, displacements, fairValueGaps);
  const shifts = detectMarketStructureShifts(snapshot.snapshotSha256, bars, swings, sweeps);
  const turtles = detectTurtleSoups(snapshot.snapshotSha256, bars, sweeps);
  const unicorns = detectUnicorns(snapshot.snapshotSha256, bars, blocks, fairValueGaps);
  const judasSwings = detectJudasSwings(snapshot.snapshotSha256, bars, turtles, displacements);
  const detections = [
    ...swings, ...fairValueGaps, ...displacements, ...sweeps, ...liquidity,
    ...sessions, ...gaps, ...quarters, ...blocks, ...shifts, ...turtles,
    ...unicorns, ...judasSwings,
  ].sort(compareDetections).slice(0, MAX_DETECTIONS);

  const latest = bars.at(-1)!;
  const latestLocal = localParts(latest.timestamp);
  const rangeBars = bars.slice(-RANGE_LOOKBACK);
  const rangeLow = Math.min(...rangeBars.map((bar) => bar.low));
  const rangeHigh = Math.max(...rangeBars.map((bar) => bar.high));
  const span = rangeHigh - rangeLow;
  const positionPercent = span === 0 ? 50 : clamp((latest.close - rangeLow) / span * 100, 0, 100);
  const annotations = buildAnnotations(detections, latest);
  const layers = buildLayers(annotations);
  const body = {
    contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
    detectorVersion: MARKET_TECHNICAL_DETECTOR_VERSION,
    snapshot: {
      id: snapshot.snapshotId,
      sha256: snapshot.snapshotSha256,
      instrumentId: snapshot.instrumentId,
      provider: snapshot.provider,
      providerSymbol: snapshot.providerSymbol,
      interval: snapshot.interval,
      firstBarAt: bars[0].timestamp,
      asOf: snapshot.asOf,
      barCount: bars.length,
    },
    timeContext: {
      timezone: NEW_YORK_TIMEZONE,
      localDate: latestLocal.date,
      localTime: `${pad(latestLocal.hour)}:${pad(latestLocal.minute)}`,
      ninetyMinuteQuarter: Math.floor(localMinutes(latestLocal) / 90) + 1,
      session: marketSession(localMinutes(latestLocal)),
      references: buildOpeningReferences(bars, latestLocal, snapshot.interval),
    },
    range: {
      lookbackBars: rangeBars.length,
      low: rangeLow,
      high: rangeHigh,
      equilibrium: (rangeLow + rangeHigh) / 2,
      latestClose: latest.close,
      positionPercent,
      zone: positionPercent > 52.5 ? "premium" as const : positionPercent < 47.5 ? "discount" as const : "equilibrium" as const,
    },
    definitions,
    detections,
    layers,
    annotations,
    counts: {
      activeFairValueGaps: countWhere(detections, (item) => item.kind === "fair_value_gap" && ["active", "partially_mitigated"].includes(item.state)),
      validOrderBlocks: countWhere(detections, (item) => item.kind === "order_block" && item.state !== "invalidated"),
      liquidityLevels: countWhere(detections, (item) => ["buy_side_liquidity", "sell_side_liquidity"].includes(item.kind) && item.state === "active"),
      sessionWindows: countWhere(detections, (item) => item.kind === "session_killzone"),
      setupCandidates: countWhere(detections, (item) => ["turtle_soup", "unicorn", "judas_swing"].includes(item.kind)),
      displacements: countWhere(detections, (item) => item.kind === "displacement"),
      liquiditySweeps: countWhere(detections, (item) => item.kind === "liquidity_sweep"),
      swingPoints: countWhere(detections, (item) => item.kind === "swing_high" || item.kind === "swing_low"),
    },
  } satisfies Omit<MarketTechnicalFeaturesResult, "resultSha256">;
  return marketTechnicalFeaturesResultSchema.parse({
    ...body,
    resultSha256: canonicalJsonSha256(body),
  });
}

function detectSwings(snapshotSha256: string, bars: MarketBar[]) {
  const result: Detection[] = [];
  for (let index = 2; index < bars.length - 2; index += 1) {
    const bar = bars[index];
    const neighbors = [bars[index - 2], bars[index - 1], bars[index + 1], bars[index + 2]];
    if (neighbors.every((candidate) => bar.high > candidate.high)) {
      result.push(makeDetection({
        snapshotSha256, definitionId: "foundation.swing.v2", kind: "swing_high",
        direction: "neutral", bar, price: bar.high,
        strength: bar.high - Math.max(...neighbors.map((candidate) => candidate.high)),
        reason: "Strict five-bar swing high.", evidence: [bars[index - 2], bars[index - 1], bar, bars[index + 1], bars[index + 2]],
      }));
    }
    if (neighbors.every((candidate) => bar.low < candidate.low)) {
      result.push(makeDetection({
        snapshotSha256, definitionId: "foundation.swing.v2", kind: "swing_low",
        direction: "neutral", bar, price: bar.low,
        strength: Math.min(...neighbors.map((candidate) => candidate.low)) - bar.low,
        reason: "Strict five-bar swing low.", evidence: [bars[index - 2], bars[index - 1], bar, bars[index + 1], bars[index + 2]],
      }));
    }
  }
  return result;
}

function detectFairValueGaps(snapshotSha256: string, bars: MarketBar[]) {
  const result: Detection[] = [];
  for (let index = 2; index < bars.length; index += 1) {
    const first = bars[index - 2];
    const third = bars[index];
    const scale = median(bars.slice(Math.max(0, index - 20), index).map(barRange)) || 1;
    if (third.low > first.high) {
      result.push(fairValueGap(snapshotSha256, bars, index, "bullish", first.high, third.low, scale));
    }
    if (third.high < first.low) {
      result.push(fairValueGap(snapshotSha256, bars, index, "bearish", third.high, first.low, scale));
    }
  }
  return result;
}

function fairValueGap(
  snapshotSha256: string,
  bars: MarketBar[],
  index: number,
  direction: "bullish" | "bearish",
  zoneLow: number,
  zoneHigh: number,
  scale: number,
) {
  const later = bars.slice(index + 1);
  const active = direction === "bullish"
    ? !later.some((bar) => bar.low <= zoneHigh)
    : !later.some((bar) => bar.high >= zoneLow);
  const mitigated = direction === "bullish"
    ? later.some((bar) => bar.low <= zoneLow)
    : later.some((bar) => bar.high >= zoneHigh);
  const state = mitigated ? "mitigated" as const : active ? "active" as const : "partially_mitigated" as const;
  return makeDetection({
    snapshotSha256, definitionId: "foundation.fvg.v2", kind: "fair_value_gap",
    direction, bar: bars[index], endBar: bars.at(-1), price: (zoneLow + zoneHigh) / 2,
    zoneLow, zoneHigh, strength: (zoneHigh - zoneLow) / scale, state,
    reason: `${direction} three-bar gap; lifecycle is ${state.replaceAll("_", " ")} at snapshot end.`,
    evidence: [bars[index - 2], bars[index - 1], bars[index]],
  });
}

function detectDisplacements(snapshotSha256: string, bars: MarketBar[]) {
  const result: Detection[] = [];
  for (let index = 20; index < bars.length; index += 1) {
    const bar = bars[index];
    const range = barRange(bar);
    const baseline = median(bars.slice(index - 20, index).map(barRange));
    if (range <= 0 || baseline <= 0) continue;
    const body = Math.abs(bar.close - bar.open);
    const closeLocation = (bar.close - bar.low) / range;
    const direction = bar.close > bar.open && closeLocation >= 0.75 ? "bullish" as const
      : bar.close < bar.open && closeLocation <= 0.25 ? "bearish" as const : null;
    if (!direction || body < baseline * 1.5) continue;
    result.push(makeDetection({
      snapshotSha256, definitionId: "foundation.displacement.v1", kind: "displacement",
      direction, bar, price: bar.close, zoneLow: bar.low, zoneHigh: bar.high,
      strength: body / baseline,
      reason: `${direction} body is ${(body / baseline).toFixed(2)}× the prior median range and closes in its outer quarter.`,
      evidence: [bar],
    }));
  }
  return result;
}

function detectLiquiditySweeps(snapshotSha256: string, bars: MarketBar[]) {
  const result: Detection[] = [];
  for (let index = 20; index < bars.length; index += 1) {
    const bar = bars[index];
    const lookback = bars.slice(index - 20, index);
    const priorHighBar = lookback.reduce((highest, item) => item.high > highest.high ? item : highest);
    const priorLowBar = lookback.reduce((lowest, item) => item.low < lowest.low ? item : lowest);
    if (bar.high > priorHighBar.high && bar.close < priorHighBar.high) {
      result.push(makeDetection({
        snapshotSha256, definitionId: "foundation.liquidity_sweep.v1", kind: "liquidity_sweep",
        direction: "bearish", bar, price: priorHighBar.high, zoneLow: priorHighBar.high,
        zoneHigh: bar.high, strength: bar.high - priorHighBar.high,
        reason: "Traded above the exact prior 20-bar high and closed back below it.", evidence: [priorHighBar, bar],
      }));
    }
    if (bar.low < priorLowBar.low && bar.close > priorLowBar.low) {
      result.push(makeDetection({
        snapshotSha256, definitionId: "foundation.liquidity_sweep.v1", kind: "liquidity_sweep",
        direction: "bullish", bar, price: priorLowBar.low, zoneLow: bar.low,
        zoneHigh: priorLowBar.low, strength: priorLowBar.low - bar.low,
        reason: "Traded below the exact prior 20-bar low and closed back above it.", evidence: [priorLowBar, bar],
      }));
    }
  }
  return result;
}

function detectLiquidityPools(snapshotSha256: string, bars: MarketBar[], swings: Detection[]) {
  const result: Detection[] = [];
  const indexes = barIndex(bars);
  for (const kind of ["swing_high", "swing_low"] as const) {
    const candidates = swings.filter((item) => item.kind === kind).sort(oldestFirst);
    for (let cursor = 1; cursor < candidates.length; cursor += 1) {
      const current = candidates[cursor];
      const currentIndex = indexes.get(current.timestamp)!;
      const tolerance = Math.max(median(bars.slice(Math.max(0, currentIndex - 20), currentIndex).map(barRange)) * 0.12, Number.EPSILON);
      const prior = [...candidates.slice(0, cursor)].reverse().find((item) => {
        const distance = currentIndex - indexes.get(item.timestamp)!;
        return distance >= 3 && distance <= 96 && Math.abs(item.price - current.price) <= tolerance;
      });
      if (!prior) continue;
      const level = (prior.price + current.price) / 2;
      const consumed = kind === "swing_high"
        ? bars.slice(currentIndex + 1).some((bar) => bar.high > level)
        : bars.slice(currentIndex + 1).some((bar) => bar.low < level);
      result.push(makeDetection({
        snapshotSha256, definitionId: "foundation.liquidity_pool.v1",
        kind: kind === "swing_high" ? "buy_side_liquidity" : "sell_side_liquidity",
        direction: "neutral", bar: bars[currentIndex], endBar: bars.at(-1), price: level,
        strength: Math.abs(prior.price - current.price), state: consumed ? "mitigated" : "active",
        reason: `${kind === "swing_high" ? "Equal highs" : "Equal lows"} across strict swings; ${consumed ? "later consumed" : "still untraded"}.`,
        evidence: [bars[indexes.get(prior.timestamp)!], bars[currentIndex]],
      }));
    }
  }
  return uniqueBy(result, (item) => `${item.kind}:${item.timestamp}:${rounded(item.price)}`);
}

function detectSessionWindows(snapshotSha256: string, bars: MarketBar[]) {
  const result: Detection[] = [];
  const entries = bars.map((bar) => ({ bar, local: localParts(bar.timestamp) }));
  for (const window of sessionWindows) {
    const groups = new Map<string, MarketBar[]>();
    for (const entry of entries) {
      const minutes = localMinutes(entry.local);
      if (minutes < window.start || minutes >= window.end) continue;
      groups.set(entry.local.date, [...(groups.get(entry.local.date) || []), entry.bar]);
    }
    for (const [date, group] of groups) {
      if (group.length < 2) continue;
      const low = Math.min(...group.map((bar) => bar.low));
      const high = Math.max(...group.map((bar) => bar.high));
      result.push(makeDetection({
        snapshotSha256, definitionId: "foundation.session_window.v1", kind: "session_killzone",
        direction: "neutral", bar: group[0], endBar: group.at(-1), price: (low + high) / 2,
        zoneLow: low, zoneHigh: high, strength: high - low,
        reason: `${window.label} · ${date} · observed range from immutable bars.`,
        evidence: [group[0], group.at(-1)!],
      }));
    }
  }
  return result;
}

function detectOpeningGaps(snapshotSha256: string, bars: MarketBar[]) {
  const result: Detection[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const prior = bars[index - 1];
    const current = bars[index];
    if (localParts(prior.timestamp).date === localParts(current.timestamp).date) continue;
    const baseline = median(bars.slice(Math.max(0, index - 20), index).map(barRange));
    const distance = Math.abs(current.open - prior.close);
    if (baseline <= 0 || distance < baseline * 0.2) continue;
    const zoneLow = Math.min(prior.close, current.open);
    const zoneHigh = Math.max(prior.close, current.open);
    const direction = current.open > prior.close ? "bullish" as const : "bearish" as const;
    const mitigated = direction === "bullish"
      ? bars.slice(index + 1).some((bar) => bar.low <= zoneLow)
      : bars.slice(index + 1).some((bar) => bar.high >= zoneHigh);
    result.push(makeDetection({
      snapshotSha256, definitionId: "foundation.calendar_gap.v1", kind: "opening_gap",
      direction, bar: current, endBar: bars.at(-1), price: (zoneLow + zoneHigh) / 2,
      zoneLow, zoneHigh, strength: distance / baseline, state: mitigated ? "mitigated" : "active",
      reason: `New York calendar-date opening gap; ${mitigated ? "later traversed" : "still open"}.`,
      evidence: [prior, current],
    }));
  }
  return result;
}

function detectQuarterOpens(snapshotSha256: string, bars: MarketBar[]) {
  const groups = new Map<string, MarketBar[]>();
  for (const bar of bars) {
    const local = localParts(bar.timestamp);
    const key = `${local.date}:q${Math.floor(localMinutes(local) / 90) + 1}`;
    groups.set(key, [...(groups.get(key) || []), bar]);
  }
  return [...groups.entries()].flatMap(([key, group]): Detection[] => {
    const first = group[0];
    const local = localParts(first.timestamp);
    if (localMinutes(local) % 90 !== 0) return [];
    return [makeDetection({
      snapshotSha256, definitionId: "foundation.quarterly_time.v1", kind: "quarterly_open",
      direction: "neutral", bar: first, endBar: group.at(-1), price: first.open, strength: 0,
      reason: `${key.replace(":", " · ").toUpperCase()} open at an observed 90-minute boundary.`,
      evidence: [first],
    })];
  });
}

function detectOrderBlocks(
  snapshotSha256: string,
  bars: MarketBar[],
  displacements: Detection[],
  fairValueGaps: Detection[],
) {
  const result: Detection[] = [];
  const indexes = barIndex(bars);
  for (const displacement of displacements) {
    const displacementIndex = indexes.get(displacement.timestamp)!;
    const confirmingGap = fairValueGaps.find((gap) => gap.direction === displacement.direction && Math.abs(indexes.get(gap.timestamp)! - displacementIndex) <= 2);
    if (!confirmingGap) continue;
    const candidateIndex = findLastIndex(bars, Math.max(0, displacementIndex - 5), displacementIndex, (bar) => displacement.direction === "bullish" ? bar.close < bar.open : bar.close > bar.open);
    if (candidateIndex < 0) continue;
    const candidate = bars[candidateIndex];
    const later = bars.slice(displacementIndex + 1);
    const invalidated = displacement.direction === "bullish" ? later.some((bar) => bar.close < candidate.low) : later.some((bar) => bar.close > candidate.high);
    const touched = displacement.direction === "bullish" ? later.some((bar) => bar.low <= candidate.high) : later.some((bar) => bar.high >= candidate.low);
    const state = invalidated ? "invalidated" as const : touched ? "partially_mitigated" as const : "active" as const;
    result.push(makeDetection({
      snapshotSha256, definitionId: "candidate.order_block.v1", kind: "order_block",
      direction: displacement.direction, bar: candidate, endBar: bars.at(-1),
      price: (candidate.low + candidate.high) / 2, zoneLow: candidate.low, zoneHigh: candidate.high,
      strength: displacement.strength, state, reviewState: "candidate_rule",
      reason: `Opposite candle before ${displacement.direction} displacement plus same-direction FVG; ${state.replaceAll("_", " ")}.`,
      evidence: [candidate, bars[displacementIndex], bars[indexes.get(confirmingGap.timestamp)!]],
    }));
  }
  return uniqueBy(result, (item) => `${item.timestamp}:${item.direction}`);
}

function detectMarketStructureShifts(
  snapshotSha256: string,
  bars: MarketBar[],
  swings: Detection[],
  sweeps: Detection[],
) {
  const result: Detection[] = [];
  const indexes = barIndex(bars);
  for (const sweep of sweeps) {
    const sweepIndex = indexes.get(sweep.timestamp)!;
    const targetKind = sweep.direction === "bearish" ? "swing_low" : "swing_high";
    const target = swings.filter((item) => item.kind === targetKind && indexes.get(item.timestamp)! < sweepIndex).sort(newestFirst)[0];
    if (!target) continue;
    const breakIndex = bars.findIndex((bar, index) => {
      if (index <= sweepIndex || index > sweepIndex + 6) return false;
      const baseline = median(bars.slice(Math.max(0, index - 20), index).map(barRange));
      const broke = sweep.direction === "bearish" ? bar.close < target.price && bar.close < bar.open : bar.close > target.price && bar.close > bar.open;
      return broke && baseline > 0 && Math.abs(bar.close - bar.open) >= baseline * 1.2;
    });
    if (breakIndex < 0) continue;
    result.push(makeDetection({
      snapshotSha256, definitionId: "candidate.market_structure_shift.v1", kind: "market_structure_shift",
      direction: sweep.direction, bar: bars[breakIndex], price: target.price,
      strength: Math.abs(bars[breakIndex].close - target.price), reviewState: "candidate_rule",
      reason: `Post-sweep close through the latest opposite ${targetKind.replace("_", " ")} with directional expansion.`,
      evidence: [bars[sweepIndex], bars[indexes.get(target.timestamp)!], bars[breakIndex]],
    }));
  }
  return result;
}

function detectTurtleSoups(snapshotSha256: string, bars: MarketBar[], sweeps: Detection[]) {
  const indexes = barIndex(bars);
  return sweeps.flatMap((sweep): Detection[] => {
    const bar = bars[indexes.get(sweep.timestamp)!];
    const window = sessionWindowAt(localMinutes(localParts(bar.timestamp)));
    if (!window) return [];
    return [makeDetection({
      snapshotSha256, definitionId: "candidate.turtle_soup.v1", kind: "turtle_soup",
      direction: sweep.direction, bar, price: sweep.price, zoneLow: optionalNumber(sweep.zoneLow),
      zoneHigh: optionalNumber(sweep.zoneHigh), strength: sweep.strength, reviewState: "candidate_rule",
      reason: `${window.label} boundary sweep and same-bar close back inside the prior 20-bar range.`,
      evidence: sweep.evidenceTimestamps.map((timestamp) => bars[indexes.get(timestamp)!]),
    })];
  });
}

function detectUnicorns(
  snapshotSha256: string,
  bars: MarketBar[],
  blocks: Detection[],
  fairValueGaps: Detection[],
) {
  const result: Detection[] = [];
  const indexes = barIndex(bars);
  for (const block of blocks.filter((item) => item.state === "invalidated")) {
    const blockIndex = indexes.get(block.timestamp)!;
    const invalidationIndex = bars.findIndex((bar, index) => index > blockIndex && (block.direction === "bullish" ? bar.close < block.zoneLow! : bar.close > block.zoneHigh!));
    if (invalidationIndex < 0) continue;
    const direction = block.direction === "bullish" ? "bearish" as const : "bullish" as const;
    const gap = fairValueGaps.find((item) => {
      const index = indexes.get(item.timestamp)!;
      return item.direction === direction && index >= invalidationIndex && index <= invalidationIndex + 8 && item.zoneLow! <= block.zoneHigh! && item.zoneHigh! >= block.zoneLow!;
    });
    if (!gap) continue;
    const zoneLow = Math.max(block.zoneLow!, gap.zoneLow!);
    const zoneHigh = Math.min(block.zoneHigh!, gap.zoneHigh!);
    const bar = bars[indexes.get(gap.timestamp)!];
    result.push(makeDetection({
      snapshotSha256, definitionId: "candidate.unicorn.v1", kind: "unicorn", direction,
      bar, endBar: bars.at(-1), price: (zoneLow + zoneHigh) / 2, zoneLow, zoneHigh,
      strength: zoneHigh - zoneLow, state: gap.state, reviewState: "candidate_rule",
      reason: "Overlap between an invalidated opposite order-block candidate and a later fair value gap.",
      evidence: [bars[blockIndex], bars[invalidationIndex], bar],
    }));
  }
  return result;
}

function detectJudasSwings(
  snapshotSha256: string,
  bars: MarketBar[],
  turtles: Detection[],
  displacements: Detection[],
) {
  const result: Detection[] = [];
  const indexes = barIndex(bars);
  for (const turtle of turtles) {
    const turtleIndex = indexes.get(turtle.timestamp)!;
    const minutes = localMinutes(localParts(turtle.timestamp));
    if (!((minutes >= 120 && minutes < 180) || (minutes >= 420 && minutes < 480))) continue;
    const followThrough = displacements.find((item) => {
      const index = indexes.get(item.timestamp)!;
      return item.direction === turtle.direction && index > turtleIndex && index <= turtleIndex + 6;
    });
    if (!followThrough) continue;
    result.push(makeDetection({
      snapshotSha256, definitionId: "candidate.judas_swing.v1", kind: "judas_swing",
      direction: turtle.direction, bar: bars[turtleIndex], endBar: bars[indexes.get(followThrough.timestamp)!],
      price: turtle.price, zoneLow: optionalNumber(turtle.zoneLow), zoneHigh: optionalNumber(turtle.zoneHigh),
      strength: followThrough.strength, reviewState: "candidate_rule",
      reason: "First-hour session sweep followed by same-direction reversal displacement within six bars.",
      evidence: [bars[turtleIndex], bars[indexes.get(followThrough.timestamp)!]],
    }));
  }
  return result;
}

function buildAnnotations(detections: Detection[], latest: MarketBar) {
  const limits: Partial<Record<Detection["kind"], number>> = {
    swing_high: 6, swing_low: 6, fair_value_gap: 16, displacement: 8,
    liquidity_sweep: 8, buy_side_liquidity: 8, sell_side_liquidity: 8,
    session_killzone: 8, opening_gap: 6, quarterly_open: 12, order_block: 10,
    market_structure_shift: 8, turtle_soup: 8, unicorn: 6, judas_swing: 6,
  };
  const counts = new Map<Detection["kind"], number>();
  const accepted = detections.filter((item) => {
    if (["fair_value_gap", "opening_gap"].includes(item.kind) && item.state === "mitigated") return false;
    if (item.kind === "order_block" && item.state === "invalidated") return false;
    if (["buy_side_liquidity", "sell_side_liquidity"].includes(item.kind) && item.state !== "active") return false;
    const count = counts.get(item.kind) || 0;
    if (count >= (limits[item.kind] || 8)) return false;
    counts.set(item.kind, count + 1);
    return true;
  });
  return accepted.flatMap((item) => annotationsFor(item, latest))
    .sort((left, right) => right.renderPriority - left.renderPriority)
    .slice(0, MAX_ANNOTATIONS);
}

function annotationsFor(item: Detection, latest: MarketBar): Annotation[] {
  const common = {
    detectionId: item.id,
    concept: item.kind,
    label: detectionLabel(item.kind),
    detail: item.reason,
    direction: item.direction,
    state: item.state,
    reviewState: item.reviewState,
  } as const;
  if (["buy_side_liquidity", "sell_side_liquidity"].includes(item.kind)) {
    return [annotation({ ...common, layerId: "liquidity", renderPriority: 94, primitive: horizontalPrimitive(item, latest.time) })];
  }
  if (item.kind === "fair_value_gap") return [annotation({ ...common, layerId: "imbalances", renderPriority: 90, primitive: zonePrimitive(item, latest.time) })];
  if (item.kind === "order_block") return [annotation({ ...common, layerId: "blocks", renderPriority: 88, primitive: zonePrimitive(item, latest.time) })];
  if (item.kind === "opening_gap") return [annotation({ ...common, layerId: "gaps", renderPriority: 84, primitive: zonePrimitive(item, latest.time) })];
  if (item.kind === "session_killzone") {
    return [annotation({ ...common, layerId: "sessions", renderPriority: 55, primitive: {
      type: "time_window", from: { time: epoch(item.timestamp), price: item.zoneHigh! },
      to: { time: epoch(item.endTimestamp!), price: item.zoneLow! },
    } })];
  }
  if (item.kind === "quarterly_open") {
    const quarterLabel = item.reason.split(" open at")[0];
    return [
      annotation({ ...common, label: `${quarterLabel} boundary`, layerId: "quarterly", renderPriority: 58, primitive: { type: "vertical_line", point: { time: epoch(item.timestamp), price: item.price } } }),
      annotation({ ...common, label: `${quarterLabel} open`, layerId: "quarterly", renderPriority: 60, primitive: horizontalPrimitive(item, epoch(item.endTimestamp!)) }),
    ];
  }
  if (item.kind === "unicorn") return [annotation({ ...common, layerId: "setups", renderPriority: 100, primitive: zonePrimitive(item, latest.time) })];
  const layerId: LayerId = ["turtle_soup", "judas_swing"].includes(item.kind) ? "setups" : item.kind === "liquidity_sweep" ? "liquidity" : "structure";
  return [annotation({
    ...common, layerId, renderPriority: ["judas_swing", "turtle_soup"].includes(item.kind) ? 96 : 70,
    primitive: { type: "marker", point: { time: epoch(item.timestamp), price: item.price }, marker: item.direction === "bullish" ? "up" : item.direction === "bearish" ? "down" : "dot" },
  })];
}

function annotation(input: Omit<Annotation, "id">): Annotation {
  return { id: `market_annotation_${digest(canonicalJsonSha256(input))}`, ...input };
}

function horizontalPrimitive(item: Detection, endTime: number) {
  return { type: "horizontal_line" as const, point: { time: epoch(item.timestamp), price: item.price }, endTime };
}

function zonePrimitive(item: Detection, fallbackEndTime: number) {
  return {
    type: "price_zone" as const,
    from: { time: epoch(item.timestamp), price: item.zoneHigh! },
    to: { time: item.endTimestamp ? epoch(item.endTimestamp) : fallbackEndTime, price: item.zoneLow! },
  };
}

function buildLayers(annotations: Annotation[]): MarketTechnicalFeaturesResult["layers"] {
  const count = (id: LayerId) => annotations.filter((item) => item.layerId === id).length;
  return [
    { id: "liquidity", label: "Liquidity", description: "Equal highs/lows and exact boundary sweeps.", defaultVisible: true, count: count("liquidity") },
    { id: "imbalances", label: "Valid FVGs", description: "Active and partially mitigated three-bar gaps.", defaultVisible: true, count: count("imbalances") },
    { id: "blocks", label: "Valid OBs", description: "Non-invalidated displacement + FVG order-block candidates.", defaultVisible: true, count: count("blocks") },
    { id: "setups", label: "ICT setups", description: "Turtle Soup, Unicorn, and Judas Swing candidates.", defaultVisible: true, count: count("setups") },
    { id: "sessions", label: "Kill zones", description: "Observed New York-time session ranges.", defaultVisible: true, count: count("sessions") },
    { id: "quarterly", label: "Quarterly time", description: "Observed 90-minute boundaries and opens.", defaultVisible: true, count: count("quarterly") },
    { id: "structure", label: "Structure", description: "Swings, displacement, and market-structure shifts.", defaultVisible: false, count: count("structure") },
    { id: "gaps", label: "Opening gaps", description: "New York calendar-date opening gaps that remain open.", defaultVisible: true, count: count("gaps") },
  ];
}

function makeDetection(input: {
  snapshotSha256: string;
  definitionId: Detection["definitionId"];
  kind: Detection["kind"];
  direction: Detection["direction"];
  bar: MarketBar;
  endBar?: MarketBar;
  price: number;
  zoneLow?: number;
  zoneHigh?: number;
  strength: number;
  state?: Detection["state"];
  reviewState?: Detection["reviewState"];
  reason: string;
  evidence: MarketBar[];
}): Detection {
  const identity = [input.snapshotSha256, input.definitionId, input.kind, input.direction,
    input.bar.timestamp, input.endBar?.timestamp ?? "none", rounded(input.price),
    input.zoneLow === undefined ? "none" : rounded(input.zoneLow),
    input.zoneHigh === undefined ? "none" : rounded(input.zoneHigh)].join(":");
  return {
    id: `market_feature_${digest(identity)}`,
    definitionId: input.definitionId,
    kind: input.kind,
    direction: input.direction,
    timestamp: input.bar.timestamp,
    endTimestamp: input.endBar?.timestamp ?? null,
    price: input.price,
    zoneLow: input.zoneLow ?? null,
    zoneHigh: input.zoneHigh ?? null,
    strength: Math.max(0, input.strength),
    state: input.state || "observed",
    reviewState: input.reviewState || "deterministic_foundation",
    reason: input.reason,
    evidenceTimestamps: [...new Set(input.evidence.map((bar) => bar.timestamp))],
  };
}

function buildOpeningReferences(
  bars: MarketBar[],
  latest: LocalParts,
  interval: MarketBarsResult["interval"],
): MarketTechnicalFeaturesResult["timeContext"]["references"] {
  const latestMinutes = localMinutes(latest);
  const quarter = Math.floor(latestMinutes / 90);
  const quarterKey = `${latest.date}:q${quarter + 1}`;
  const weekKey = mondayOfWeek(latest.date);
  const monthKey = `${latest.year}-${pad(latest.month)}`;
  const entries = bars.map((bar) => ({ bar, local: localParts(bar.timestamp) }));
  const intervalMinutes = interval === "5min" ? 5 : interval === "15min" ? 15 : 60;
  return [
    openingReference("ninety_minute", "Current 90-minute open", `${latest.date} · Q${quarter + 1} · New York time`, entries.find(({ local }) => `${local.date}:q${Math.floor(localMinutes(local) / 90) + 1}` === quarterKey), ({ local }) => localMinutes(local) - quarter * 90 <= intervalMinutes),
    openingReference("day", "Calendar-day open", `${latest.date} · New York time`, entries.find(({ local }) => local.date === latest.date), ({ local }) => localMinutes(local) <= intervalMinutes),
    openingReference("week", "Calendar-week open", `Week of ${weekKey} · New York time`, entries.find(({ local }) => mondayOfWeek(local.date) === weekKey), ({ local }) => local.date === weekKey && localMinutes(local) <= intervalMinutes),
    openingReference("month", "Calendar-month open", `${monthKey} · New York time`, entries.find(({ local }) => `${local.year}-${pad(local.month)}` === monthKey), ({ local }) => local.day === 1 && localMinutes(local) <= intervalMinutes),
  ];
}

function openingReference(
  id: MarketTechnicalFeaturesResult["timeContext"]["references"][number]["id"],
  label: string,
  period: string,
  entry: { bar: MarketBar; local: LocalParts } | undefined,
  boundary: (entry: { bar: MarketBar; local: LocalParts }) => boolean,
) {
  const available = Boolean(entry && boundary(entry));
  return { id, label, period, open: available ? entry!.bar.open : null, status: available ? "available" as const : "outside_snapshot" as const };
}

function localParts(timestamp: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NEW_YORK_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return { date: `${year}-${pad(month)}-${pad(day)}`, year, month, day, hour: value("hour"), minute: value("minute") };
}

function marketSession(minutes: number): MarketTechnicalFeaturesResult["timeContext"]["session"] {
  if (minutes >= 18 * 60) return "asia_evening";
  if (minutes >= 2 * 60 && minutes < 5 * 60) return "london_open";
  if (minutes >= 8 * 60 + 30 && minutes < 12 * 60) return "new_york_am";
  if (minutes >= 13 * 60 + 30 && minutes < 16 * 60) return "new_york_pm";
  return "off_hours";
}

function detectionLabel(kind: Detection["kind"]) {
  const labels: Record<Detection["kind"], string> = {
    swing_high: "Swing high", swing_low: "Swing low", fair_value_gap: "Fair value gap",
    displacement: "Displacement", liquidity_sweep: "Liquidity sweep",
    buy_side_liquidity: "Buy-side liquidity", sell_side_liquidity: "Sell-side liquidity",
    session_killzone: "Session window", opening_gap: "Opening gap", quarterly_open: "Quarterly open",
    order_block: "Order block", market_structure_shift: "Market structure shift",
    turtle_soup: "Turtle Soup", unicorn: "Unicorn", judas_swing: "Judas Swing",
  };
  return labels[kind];
}

function sessionWindowAt(minutes: number) {
  return sessionWindows.find((window) => minutes >= window.start && minutes < window.end);
}
function compareDetections(left: Detection, right: Detection) { return newestFirst(left, right) || left.id.localeCompare(right.id); }
function newestFirst(left: Detection, right: Detection) { return Date.parse(right.timestamp) - Date.parse(left.timestamp); }
function oldestFirst(left: Detection, right: Detection) { return Date.parse(left.timestamp) - Date.parse(right.timestamp); }
function barIndex(bars: MarketBar[]) { return new Map(bars.map((bar, index) => [bar.timestamp, index])); }
function countWhere(values: Detection[], predicate: (value: Detection) => boolean) { return values.filter(predicate).length; }
function optionalNumber(value: number | null) { return value === null ? undefined : value; }
function findLastIndex(bars: MarketBar[], start: number, end: number, predicate: (bar: MarketBar) => boolean) { for (let index = end - 1; index >= start; index -= 1) if (predicate(bars[index])) return index; return -1; }
function uniqueBy<T>(values: T[], key: (value: T) => string) { const seen = new Set<string>(); return values.filter((value) => { const id = key(value); if (seen.has(id)) return false; seen.add(id); return true; }); }
function mondayOfWeek(date: string) { const cursor = new Date(`${date}T12:00:00.000Z`); cursor.setUTCDate(cursor.getUTCDate() - (cursor.getUTCDay() + 6) % 7); return cursor.toISOString().slice(0, 10); }
function assertStrictChronology(bars: MarketBar[]) { for (let index = 1; index < bars.length; index += 1) if (bars[index].time <= bars[index - 1].time) throw new Error("Technical features require unique chronological bars."); }
function barRange(bar: MarketBar) { return bar.high - bar.low; }
function median(values: number[]) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function localMinutes(value: LocalParts) { return value.hour * 60 + value.minute; }
function epoch(timestamp: string) { return Math.floor(Date.parse(timestamp) / 1_000); }
function pad(value: number) { return String(value).padStart(2, "0"); }
function clamp(value: number, minimum: number, maximum: number) { return Math.min(maximum, Math.max(minimum, value)); }
function rounded(value: number) { return Number(value.toPrecision(12)); }
function digest(value: string) { return createHash("sha256").update(value).digest("hex").slice(0, 48); }
