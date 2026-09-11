import {
  MARKET_EVENT_BASELINE_VERSION,
  MARKET_RESEARCH_CONTRACT_VERSION,
  marketEventBaselinesResultSchema,
  type MarketEventBaseline,
  type MarketEventBaselinesResult,
  type MarketEventReplay,
} from "@/lib/market-research/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type ReturnField = "post5m" | "post15m" | "post60m" | "post240m";

export function buildMarketEventBaselines(input: {
  instrumentId: string;
  minimumSampleSize: number;
  replays: MarketEventReplay[];
}): MarketEventBaselinesResult {
  const groups = new Map<string, MarketEventReplay[]>();
  for (const replay of input.replays) {
    if (replay.instrumentId !== input.instrumentId) {
      throw new Error("Market baseline replay instrument does not match its request.");
    }
    const matches = groups.get(replay.eventKey) || [];
    matches.push(replay);
    groups.set(replay.eventKey, matches);
  }

  const baselines = [...groups.entries()].map(([eventKey, replays]) =>
    buildGroup(eventKey, replays, input.minimumSampleSize)
  ).sort((left, right) =>
    right.sampleSize - left.sampleSize || left.eventKey.localeCompare(right.eventKey)
  );
  const body = {
    contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
    baselineVersion: MARKET_EVENT_BASELINE_VERSION,
    instrumentId: input.instrumentId,
    minimumSampleSize: input.minimumSampleSize,
    includedReplays: input.replays.length,
    groups: baselines,
    interpretation: "descriptive_not_predictive" as const,
  } satisfies Omit<MarketEventBaselinesResult, "resultSha256">;

  return marketEventBaselinesResultSchema.parse({
    ...body,
    resultSha256: canonicalJsonSha256(body),
  });
}

function buildGroup(
  eventKey: string,
  replays: MarketEventReplay[],
  minimumSampleSize: number,
): MarketEventBaseline {
  const ordered = [...replays].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt)
  );
  const up = replays.filter((replay) => replay.direction === "up").length;
  const down = replays.filter((replay) => replay.direction === "down").length;
  const flat = replays.length - up - down;
  const favorable = numeric(replays.map((replay) => replay.maxFavorableBps));
  const adverse = numeric(replays.map((replay) => replay.maxAdverseBps));
  const excursionSampleSize = Math.min(favorable.length, adverse.length);

  return {
    eventKey,
    sampleSize: replays.length,
    state: replays.length >= minimumSampleSize
      ? "descriptive_baseline"
      : "low_sample",
    firstOccurredAt: ordered[0].occurredAt,
    lastOccurredAt: ordered.at(-1)!.occurredAt,
    directions: { up, down, flat },
    empiricalRates: {
      up: up / replays.length,
      down: down / replays.length,
      flat: flat / replays.length,
    },
    post5m: distribution(replays, "post5m"),
    post15m: distribution(replays, "post15m"),
    post60m: distribution(replays, "post60m"),
    post240m: distribution(replays, "post240m"),
    excursions: {
      sampleSize: excursionSampleSize,
      medianFavorableBps: favorable.length ? quantile(favorable, 0.5) : null,
      medianAdverseBps: adverse.length ? quantile(adverse, 0.5) : null,
    },
  };
}

function distribution(replays: MarketEventReplay[], field: ReturnField) {
  const values = replays.flatMap((replay) => {
    const point = replay[field];
    return point ? [point.returnBps] : [];
  });
  return {
    sampleSize: values.length,
    meanBps: values.length
      ? values.reduce((total, value) => total + value, 0) / values.length
      : null,
    medianBps: values.length ? quantile(values, 0.5) : null,
    lowerQuartileBps: values.length ? quantile(values, 0.25) : null,
    upperQuartileBps: values.length ? quantile(values, 0.75) : null,
  };
}

function numeric(values: Array<number | null>) {
  return values.filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value)
  );
}

function quantile(values: number[], percentile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
