import { createHash } from "node:crypto";
import { z } from "zod";

import {
  MARKET_FORWARD_SHADOW_VERSION,
  MARKET_TECHNICAL_DETECTOR_VERSION,
  marketBarsProviderResultSchema,
  marketForecastOutcomeSchema,
  marketForwardForecastSchema,
  type MarketBarsProviderResult,
  type MarketEventBaselinesResult,
  type MarketEvent,
  type MarketForecastHorizon,
  type MarketForecastOutcome,
  type MarketForwardForecast,
  type MarketTechnicalFeaturesResult,
} from "@/lib/market-research/contracts";
import { zonedDateTimeToIso } from "@/lib/market-research/official-schedules";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const NEW_YORK_TIMEZONE = "America/New_York";
const MINIMUM_LEAD_MINUTES = 45;

const modelPriceZoneSchema = z.object({
  low: z.number().finite(),
  high: z.number().finite(),
}).strict().nullable();

export const marketForecastModelOutputSchema = z.object({
  stance: z.enum(["bullish", "bearish", "neutral", "abstain"]),
  evidenceStrength: z.enum(["insufficient", "limited", "developing"]),
  summary: z.string().trim().min(1).max(1_600),
  scenarios: z.array(z.object({
    direction: z.enum(["bullish", "bearish", "neutral"]),
    rank: z.number().int().min(1).max(3),
    thesis: z.string().trim().min(1).max(1_200),
    observationZone: modelPriceZoneSchema,
    targets: z.array(z.number().finite()).max(3),
    invalidation: z.object({
      price: z.number().finite(),
      rationale: z.string().trim().min(1).max(500),
    }).strict().nullable(),
    supportingFeatureIds: z.array(
      z.string().regex(/^market_feature_[a-f0-9]{48}$/),
    ).max(12),
  }).strict()).length(3),
  warnings: z.array(z.string().trim().min(1).max(600)).max(7),
}).strict();

export type MarketForecastModelOutput = z.infer<
  typeof marketForecastModelOutputSchema
>;

export const marketForecastModelJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["stance", "evidenceStrength", "summary", "scenarios", "warnings"],
  properties: {
    stance: { type: "string", enum: ["bullish", "bearish", "neutral", "abstain"] },
    evidenceStrength: { type: "string", enum: ["insufficient", "limited", "developing"] },
    summary: { type: "string", minLength: 1, maxLength: 1_600 },
    scenarios: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "direction",
          "rank",
          "thesis",
          "observationZone",
          "targets",
          "invalidation",
          "supportingFeatureIds",
        ],
        properties: {
          direction: { type: "string", enum: ["bullish", "bearish", "neutral"] },
          rank: { type: "integer", minimum: 1, maximum: 3 },
          thesis: { type: "string", minLength: 1, maxLength: 1_200 },
          observationZone: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["low", "high"],
                properties: {
                  low: { type: "number" },
                  high: { type: "number" },
                },
              },
              { type: "null" },
            ],
          },
          targets: { type: "array", maxItems: 3, items: { type: "number" } },
          invalidation: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["price", "rationale"],
                properties: {
                  price: { type: "number" },
                  rationale: { type: "string", minLength: 1, maxLength: 500 },
                },
              },
              { type: "null" },
            ],
          },
          supportingFeatureIds: {
            type: "array",
            maxItems: 12,
            items: { type: "string", pattern: "^market_feature_[a-f0-9]{48}$" },
          },
        },
      },
    },
    warnings: {
      type: "array",
      maxItems: 7,
      items: { type: "string", minLength: 1, maxLength: 600 },
    },
  },
} as const;

export type MarketForecastWindow = Readonly<{
  start: string;
  end: string;
}>;

export function buildMarketForecastWindow(input: {
  horizon: MarketForecastHorizon;
  now?: Date;
}): MarketForecastWindow {
  const now = input.now || new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Market forecast clock is invalid.");
  }
  const local = newYorkParts(now);
  const leadCutoffMinutes = 9 * 60 + 30 - MINIMUM_LEAD_MINUTES;
  let date = local.date;

  if (input.horizon === "daily") {
    if (!isWeekday(local.weekday) || local.minutes > leadCutoffMinutes) {
      date = nextWeekday(date);
    }
    return {
      start: localMarketTime(date, 9, 30),
      end: localMarketTime(date, 16, 0),
    };
  }

  const canUseToday = local.weekday === 1 && local.minutes <= leadCutoffMinutes;
  if (!canUseToday) {
    date = nextWeekdayNumber(date, 1);
  }
  const friday = addLocalDays(date, 4);
  return {
    start: localMarketTime(date, 9, 30),
    end: localMarketTime(friday, 16, 0),
  };
}

export function buildMarketForwardForecast(input: {
  tenantId: string;
  actorId: string;
  instrumentId: string;
  horizon: MarketForecastHorizon;
  window: MarketForecastWindow;
  sealedAt: string;
  modelOutput: MarketForecastModelOutput;
  features: MarketTechnicalFeaturesResult;
  baselines: MarketEventBaselinesResult;
  macroEvents: MarketEvent[];
  modelAttribution: MarketForwardForecast["modelAttribution"];
}): MarketForwardForecast {
  const modelOutput = marketForecastModelOutputSchema.parse(input.modelOutput);
  const allowedFeatureIds = new Set(
    input.features.detections.map((feature) => feature.id),
  );
  for (const scenario of modelOutput.scenarios) {
    if (scenario.supportingFeatureIds.some((id) => !allowedFeatureIds.has(id))) {
      throw new Error("Market forecast cited a technical feature outside its snapshot.");
    }
  }
  assertPriceAnchors(modelOutput, input.features);
  const macroEvents = [...input.macroEvents]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 24);
  const deterministicWarnings = [
    "No calibrated probability is available; scenario ordering is not a probability forecast.",
    "Research only. This journal cannot place, modify, or manage trades.",
    "Technical primitives are deterministic foundations and do not claim transcript authority.",
  ];
  const body = {
    contractVersion: MARKET_FORWARD_SHADOW_VERSION,
    instrumentId: input.instrumentId,
    horizon: input.horizon,
    windowStart: input.window.start,
    windowEnd: input.window.end,
    sealedAt: input.sealedAt,
    researchMode: true as const,
    probabilityState: "uncalibrated" as const,
    stance: modelOutput.stance,
    evidenceStrength: modelOutput.evidenceStrength,
    summary: modelOutput.summary,
    scenarios: [...modelOutput.scenarios].sort((left, right) => left.rank - right.rank),
    warnings: uniqueStrings([...deterministicWarnings, ...modelOutput.warnings]).slice(0, 10),
    evidence: {
      snapshotId: input.features.snapshot.id,
      snapshotSha256: input.features.snapshot.sha256,
      snapshotAsOf: input.features.snapshot.asOf,
      detectorVersion: MARKET_TECHNICAL_DETECTOR_VERSION,
      technicalResultSha256: input.features.resultSha256,
      baselineVersion: input.baselines.baselineVersion,
      baselineResultSha256: input.baselines.resultSha256,
      baselineReplayCount: input.baselines.includedReplays,
      baselineQualifiedGroups: input.baselines.groups.filter((group) =>
        group.state === "descriptive_baseline"
      ).length,
      macroEventIds: macroEvents.map((event) => event.id),
      macroEventsSha256: canonicalJsonSha256(macroEvents),
    },
    modelAttribution: input.modelAttribution,
  };
  const forecastSha256 = canonicalJsonSha256(body);
  const id = `market_forecast_${digest({
    tenantId: input.tenantId,
    actorId: input.actorId,
    forecastSha256,
  })}`;
  return marketForwardForecastSchema.parse({
    id,
    ...body,
    forecastSha256,
  });
}

export function scoreMarketForwardForecast(input: {
  forecast: MarketForwardForecast;
  result: MarketBarsProviderResult;
  sourcePayload: unknown;
  resolvedAt?: string;
}): MarketForecastOutcome {
  const forecast = marketForwardForecastSchema.parse(input.forecast);
  const result = marketBarsProviderResultSchema.parse(input.result);
  if (result.instrumentId !== forecast.instrumentId) {
    throw new Error("Market forecast outcome instrument does not match its forecast.");
  }
  const start = Date.parse(forecast.windowStart) / 1_000;
  const end = Date.parse(forecast.windowEnd) / 1_000;
  const bars = result.bars.filter((bar) => bar.time >= start && bar.time <= end);
  if (bars.length < 2) {
    throw new Error("Market forecast outcome requires at least two bars inside its window.");
  }
  const firstPrice = bars[0].open;
  const lastPrice = bars.at(-1)!.close;
  const returnBps = basisPoints(lastPrice, firstPrice);
  const actualDirection = returnBps > 5
    ? "bullish" as const
    : returnBps < -5
      ? "bearish" as const
      : "neutral" as const;
  const rankedScenario = forecast.scenarios.find((scenario) =>
    scenario.direction === actualDirection
  )!;
  const stanceDirection = forecast.stance === "abstain" ? null : forecast.stance;
  const excursion = stanceDirection === "bullish"
    ? {
        favorable: Math.max(0, basisPoints(Math.max(...bars.map((bar) => bar.high)), firstPrice)),
        adverse: Math.max(0, -basisPoints(Math.min(...bars.map((bar) => bar.low)), firstPrice)),
      }
    : stanceDirection === "bearish"
      ? {
          favorable: Math.max(0, -basisPoints(Math.min(...bars.map((bar) => bar.low)), firstPrice)),
          adverse: Math.max(0, basisPoints(Math.max(...bars.map((bar) => bar.high)), firstPrice)),
        }
      : null;
  const sourcePayloadSha256 = canonicalJsonSha256(input.sourcePayload);
  const snapshotSha256 = canonicalJsonSha256(result.bars);
  const resolvedAt = input.resolvedAt || new Date().toISOString();
  const body = {
    forecastId: forecast.id,
    resolvedAt,
    provider: result.provider,
    providerSymbol: result.providerSymbol,
    interval: result.interval,
    sourcePayloadSha256,
    snapshotSha256,
    firstPrice,
    lastPrice,
    returnBps,
    actualDirection,
    stanceHit: stanceDirection ? stanceDirection === actualDirection : null,
    scenarioRankHit: rankedScenario.rank,
    maxFavorableBps: excursion?.favorable ?? null,
    maxAdverseBps: excursion?.adverse ?? null,
    brierScore: null,
  };
  const outcomeSha256 = canonicalJsonSha256(body);
  return marketForecastOutcomeSchema.parse({
    id: `market_forecast_outcome_${digest({ forecastId: forecast.id, outcomeSha256 })}`,
    ...body,
    outcomeSha256,
  });
}

export function forecastWindowInterval(horizon: MarketForecastHorizon) {
  return horizon === "daily" ? "15min" as const : "1h" as const;
}

function assertPriceAnchors(
  output: MarketForecastModelOutput,
  features: MarketTechnicalFeaturesResult,
) {
  const span = Math.max(
    features.range.high - features.range.low,
    features.range.latestClose * 0.02,
  );
  const minimum = features.range.low - span * 2;
  const maximum = features.range.high + span * 2;
  const anchors = output.scenarios.flatMap((scenario) => [
    ...(scenario.observationZone
      ? [scenario.observationZone.low, scenario.observationZone.high]
      : []),
    ...scenario.targets,
    ...(scenario.invalidation ? [scenario.invalidation.price] : []),
  ]);
  if (anchors.some((price) => price < minimum || price > maximum)) {
    throw new Error("Market forecast returned a price anchor outside its bounded snapshot range.");
  }
}

function newYorkParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    weekday: weekdays[value("weekday")],
    minutes: hour * 60 + minute,
  };
}

function nextWeekday(date: string) {
  let candidate = addLocalDays(date, 1);
  while (!isWeekday(weekday(candidate))) candidate = addLocalDays(candidate, 1);
  return candidate;
}

function nextWeekdayNumber(date: string, target: number) {
  let candidate = addLocalDays(date, 1);
  while (weekday(candidate) !== target) candidate = addLocalDays(candidate, 1);
  return candidate;
}

function weekday(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function isWeekday(value: number) {
  return value >= 1 && value <= 5;
}

function addLocalDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function localMarketTime(date: string, hour: number, minute: number) {
  const [year, month, day] = date.split("-").map(Number);
  return zonedDateTimeToIso({ year, month, day, hour, minute, second: 0 }, NEW_YORK_TIMEZONE);
}

function basisPoints(value: number, baseline: number) {
  return Math.round(((value - baseline) / baseline) * 10_000 * 1_000) / 1_000;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 48);
}
