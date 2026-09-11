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
const DISPLACEMENT_LOOKBACK = 20;
const SWEEP_LOOKBACK = 20;
const RANGE_LOOKBACK = 96;
const MAX_DETECTIONS = 120;

type LocalParts = {
  date: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

type Detection = MarketTechnicalFeaturesResult["detections"][number];

export class MarketTechnicalInsufficientDataError extends Error {
  constructor() {
    super("At least five immutable market bars are required for technical features.");
    this.name = "MarketTechnicalInsufficientDataError";
  }
}

const definitions: MarketTechnicalFeaturesResult["definitions"] = [
  {
    id: "foundation.swing.v1",
    label: "Five-bar swing",
    formula: "A swing high is higher than the two bars on each side; a swing low is lower than the two bars on each side. Equal highs or lows do not qualify.",
    reviewState: "deterministic_foundation",
    transcriptAuthority: "not_claimed",
  },
  {
    id: "foundation.fvg.v1",
    label: "Three-bar price gap",
    formula: "Bullish when bar three's low is above bar one's high; bearish when bar three's high is below bar one's low. Any later touch marks the zone mitigated.",
    reviewState: "deterministic_foundation",
    transcriptAuthority: "not_claimed",
  },
  {
    id: "foundation.displacement.v1",
    label: "Range-relative displacement",
    formula: "Candle body must be at least 1.5 times the median range of the prior 20 bars and close within the directional outer quarter of its own range.",
    reviewState: "deterministic_foundation",
    transcriptAuthority: "not_claimed",
  },
  {
    id: "foundation.liquidity_sweep.v1",
    label: "Twenty-bar boundary sweep",
    formula: "Price must trade beyond the prior 20-bar high or low and close back inside that exact boundary on the same bar.",
    reviewState: "deterministic_foundation",
    transcriptAuthority: "not_claimed",
  },
];

export function buildMarketTechnicalFeatures(
  input: MarketBarsResult,
): MarketTechnicalFeaturesResult {
  const snapshot = marketBarsResultSchema.parse(input);
  const bars = [...snapshot.bars].sort((left, right) => left.time - right.time);
  if (bars.length < 5) throw new MarketTechnicalInsufficientDataError();
  assertStrictChronology(bars);

  const latest = bars.at(-1)!;
  const latestLocal = localParts(latest.timestamp);
  const detections = [
    ...detectSwings(snapshot.snapshotSha256, bars),
    ...detectFairValueGaps(snapshot.snapshotSha256, bars),
    ...detectDisplacements(snapshot.snapshotSha256, bars),
    ...detectLiquiditySweeps(snapshot.snapshotSha256, bars),
  ].sort((left, right) => (
    Date.parse(right.timestamp) - Date.parse(left.timestamp) ||
    left.id.localeCompare(right.id)
  )).slice(0, MAX_DETECTIONS);
  const rangeBars = bars.slice(-RANGE_LOOKBACK);
  const rangeLow = Math.min(...rangeBars.map((bar) => bar.low));
  const rangeHigh = Math.max(...rangeBars.map((bar) => bar.high));
  const span = rangeHigh - rangeLow;
  const positionPercent = span === 0
    ? 50
    : clamp((latest.close - rangeLow) / span * 100, 0, 100);

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
      zone: positionPercent > 52.5
        ? "premium" as const
        : positionPercent < 47.5
          ? "discount" as const
          : "equilibrium" as const,
    },
    definitions,
    detections,
    counts: {
      activeFairValueGaps: detections.filter((item) =>
        item.kind === "fair_value_gap" && item.state === "active"
      ).length,
      displacements: detections.filter((item) => item.kind === "displacement").length,
      liquiditySweeps: detections.filter((item) => item.kind === "liquidity_sweep").length,
      swingPoints: detections.filter((item) =>
        item.kind === "swing_high" || item.kind === "swing_low"
      ).length,
    },
  } satisfies Omit<MarketTechnicalFeaturesResult, "resultSha256">;

  return marketTechnicalFeaturesResultSchema.parse({
    ...body,
    resultSha256: canonicalJsonSha256(body),
  });
}

function detectSwings(snapshotSha256: string, bars: MarketBar[]) {
  const detections: Detection[] = [];
  for (let index = 2; index < bars.length - 2; index += 1) {
    const bar = bars[index];
    const neighbors = [bars[index - 2], bars[index - 1], bars[index + 1], bars[index + 2]];
    if (neighbors.every((candidate) => bar.high > candidate.high)) {
      detections.push(detection({
        snapshotSha256,
        definitionId: "foundation.swing.v1",
        kind: "swing_high",
        direction: "bearish",
        bar,
        price: bar.high,
        strength: bar.high - Math.max(...neighbors.map((candidate) => candidate.high)),
      }));
    }
    if (neighbors.every((candidate) => bar.low < candidate.low)) {
      detections.push(detection({
        snapshotSha256,
        definitionId: "foundation.swing.v1",
        kind: "swing_low",
        direction: "bullish",
        bar,
        price: bar.low,
        strength: Math.min(...neighbors.map((candidate) => candidate.low)) - bar.low,
      }));
    }
  }
  return detections;
}

function detectFairValueGaps(snapshotSha256: string, bars: MarketBar[]) {
  const detections: Detection[] = [];
  for (let index = 2; index < bars.length; index += 1) {
    const first = bars[index - 2];
    const third = bars[index];
    const priorRanges = bars.slice(Math.max(0, index - 20), index).map(barRange);
    const scale = median(priorRanges) || 1;
    if (third.low > first.high) {
      const zoneLow = first.high;
      const zoneHigh = third.low;
      const touched = bars.slice(index + 1).some((candidate) => candidate.low <= zoneHigh);
      detections.push(detection({
        snapshotSha256,
        definitionId: "foundation.fvg.v1",
        kind: "fair_value_gap",
        direction: "bullish",
        bar: third,
        price: (zoneLow + zoneHigh) / 2,
        zoneLow,
        zoneHigh,
        strength: (zoneHigh - zoneLow) / scale,
        state: touched ? "mitigated" : "active",
      }));
    }
    if (third.high < first.low) {
      const zoneLow = third.high;
      const zoneHigh = first.low;
      const touched = bars.slice(index + 1).some((candidate) => candidate.high >= zoneLow);
      detections.push(detection({
        snapshotSha256,
        definitionId: "foundation.fvg.v1",
        kind: "fair_value_gap",
        direction: "bearish",
        bar: third,
        price: (zoneLow + zoneHigh) / 2,
        zoneLow,
        zoneHigh,
        strength: (zoneHigh - zoneLow) / scale,
        state: touched ? "mitigated" : "active",
      }));
    }
  }
  return detections;
}

function detectDisplacements(snapshotSha256: string, bars: MarketBar[]) {
  const detections: Detection[] = [];
  for (let index = DISPLACEMENT_LOOKBACK; index < bars.length; index += 1) {
    const bar = bars[index];
    const range = barRange(bar);
    if (range === 0) continue;
    const baseline = median(
      bars.slice(index - DISPLACEMENT_LOOKBACK, index).map(barRange),
    );
    if (baseline <= 0) continue;
    const body = Math.abs(bar.close - bar.open);
    const closeLocation = (bar.close - bar.low) / range;
    const direction = bar.close > bar.open && closeLocation >= 0.75
      ? "bullish" as const
      : bar.close < bar.open && closeLocation <= 0.25
        ? "bearish" as const
        : null;
    if (!direction || body < baseline * 1.5) continue;
    detections.push(detection({
      snapshotSha256,
      definitionId: "foundation.displacement.v1",
      kind: "displacement",
      direction,
      bar,
      price: bar.close,
      zoneLow: bar.low,
      zoneHigh: bar.high,
      strength: body / baseline,
    }));
  }
  return detections;
}

function detectLiquiditySweeps(snapshotSha256: string, bars: MarketBar[]) {
  const detections: Detection[] = [];
  for (let index = SWEEP_LOOKBACK; index < bars.length; index += 1) {
    const bar = bars[index];
    const lookback = bars.slice(index - SWEEP_LOOKBACK, index);
    const priorHigh = Math.max(...lookback.map((candidate) => candidate.high));
    const priorLow = Math.min(...lookback.map((candidate) => candidate.low));
    if (bar.high > priorHigh && bar.close < priorHigh) {
      detections.push(detection({
        snapshotSha256,
        definitionId: "foundation.liquidity_sweep.v1",
        kind: "liquidity_sweep",
        direction: "bearish",
        bar,
        price: priorHigh,
        zoneLow: priorHigh,
        zoneHigh: bar.high,
        strength: bar.high - priorHigh,
      }));
    }
    if (bar.low < priorLow && bar.close > priorLow) {
      detections.push(detection({
        snapshotSha256,
        definitionId: "foundation.liquidity_sweep.v1",
        kind: "liquidity_sweep",
        direction: "bullish",
        bar,
        price: priorLow,
        zoneLow: bar.low,
        zoneHigh: priorLow,
        strength: priorLow - bar.low,
      }));
    }
  }
  return detections;
}

function detection(input: {
  snapshotSha256: string;
  definitionId: Detection["definitionId"];
  kind: Detection["kind"];
  direction: Detection["direction"];
  bar: MarketBar;
  price: number;
  zoneLow?: number;
  zoneHigh?: number;
  strength: number;
  state?: Detection["state"];
}): Detection {
  const identity = [
    input.snapshotSha256,
    input.definitionId,
    input.kind,
    input.direction,
    input.bar.timestamp,
    input.price,
    input.zoneLow ?? "none",
    input.zoneHigh ?? "none",
  ].join(":");
  return {
    id: `market_feature_${digest(identity)}`,
    definitionId: input.definitionId,
    kind: input.kind,
    direction: input.direction,
    timestamp: input.bar.timestamp,
    price: input.price,
    zoneLow: input.zoneLow ?? null,
    zoneHigh: input.zoneHigh ?? null,
    strength: Math.max(0, input.strength),
    state: input.state || "observed",
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
    openingReference({
      id: "ninety_minute",
      label: "Current 90-minute open",
      period: `${latest.date} · Q${quarter + 1} · New York time`,
      entry: entries.find(({ local }) =>
        `${local.date}:q${Math.floor(localMinutes(local) / 90) + 1}` === quarterKey
      ),
      boundary: ({ local }) => localMinutes(local) - quarter * 90 <= intervalMinutes,
    }),
    openingReference({
      id: "day",
      label: "Calendar-day open",
      period: `${latest.date} · New York time`,
      entry: entries.find(({ local }) => local.date === latest.date),
      boundary: ({ local }) => localMinutes(local) <= intervalMinutes,
    }),
    openingReference({
      id: "week",
      label: "Calendar-week open",
      period: `Week of ${weekKey} · New York time`,
      entry: entries.find(({ local }) => mondayOfWeek(local.date) === weekKey),
      boundary: ({ local }) => local.date === weekKey && localMinutes(local) <= intervalMinutes,
    }),
    openingReference({
      id: "month",
      label: "Calendar-month open",
      period: `${monthKey} · New York time`,
      entry: entries.find(({ local }) =>
        `${local.year}-${pad(local.month)}` === monthKey
      ),
      boundary: ({ local }) => local.day === 1 && localMinutes(local) <= intervalMinutes,
    }),
  ];
}

function openingReference(input: {
  id: MarketTechnicalFeaturesResult["timeContext"]["references"][number]["id"];
  label: string;
  period: string;
  entry: { bar: MarketBar; local: LocalParts } | undefined;
  boundary: (entry: { bar: MarketBar; local: LocalParts }) => boolean;
}) {
  const available = Boolean(input.entry && input.boundary(input.entry));
  return {
    id: input.id,
    label: input.label,
    period: input.period,
    open: available ? input.entry!.bar.open : null,
    status: available ? "available" as const : "outside_snapshot" as const,
  };
}

function localParts(timestamp: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NEW_YORK_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return {
    date: `${year}-${pad(month)}-${pad(day)}`,
    year,
    month,
    day,
    hour: value("hour"),
    minute: value("minute"),
  };
}

function marketSession(minutes: number): MarketTechnicalFeaturesResult["timeContext"]["session"] {
  if (minutes >= 18 * 60) return "asia_evening";
  if (minutes >= 2 * 60 && minutes < 5 * 60) return "london_open";
  if (minutes >= 8 * 60 + 30 && minutes < 12 * 60) return "new_york_am";
  if (minutes >= 13 * 60 + 30 && minutes < 16 * 60) return "new_york_pm";
  return "off_hours";
}

function mondayOfWeek(date: string) {
  const cursor = new Date(`${date}T12:00:00.000Z`);
  const weekday = cursor.getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  cursor.setUTCDate(cursor.getUTCDate() - daysSinceMonday);
  return cursor.toISOString().slice(0, 10);
}

function assertStrictChronology(bars: MarketBar[]) {
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].time <= bars[index - 1].time) {
      throw new Error("Technical features require unique chronological bars.");
    }
  }
}

function barRange(bar: MarketBar) {
  return bar.high - bar.low;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function localMinutes(value: LocalParts) {
  return value.hour * 60 + value.minute;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 48);
}
