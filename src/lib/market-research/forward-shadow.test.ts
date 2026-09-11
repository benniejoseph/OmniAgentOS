import { describe, expect, it } from "vitest";

import {
  MARKET_EVENT_BASELINE_VERSION,
  MARKET_RESEARCH_CONTRACT_VERSION,
  marketBarsProviderResultSchema,
  marketBarsResultSchema,
  marketEventBaselinesResultSchema,
} from "@/lib/market-research/contracts";
import {
  buildMarketForecastWindow,
  buildMarketForwardForecast,
  scoreMarketForwardForecast,
} from "@/lib/market-research/forward-shadow";
import { buildMarketTechnicalFeatures } from "@/lib/market-research/technical-features";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

describe("market forward shadow", () => {
  it("selects a future New York session before the sealing cutoff", () => {
    expect(buildMarketForecastWindow({
      horizon: "daily",
      now: new Date("2026-09-14T12:30:00.000Z"),
    })).toEqual({
      start: "2026-09-14T13:30:00.000Z",
      end: "2026-09-14T20:00:00.000Z",
    });
    expect(buildMarketForecastWindow({
      horizon: "daily",
      now: new Date("2026-09-14T13:00:00.000Z"),
    }).start).toBe("2026-09-15T13:30:00.000Z");
    expect(buildMarketForecastWindow({
      horizon: "weekly",
      now: new Date("2026-09-15T12:00:00.000Z"),
    })).toEqual({
      start: "2026-09-21T13:30:00.000Z",
      end: "2026-09-25T20:00:00.000Z",
    });
  });

  it("seals one ranked scenario per direction with immutable receipts", () => {
    const forecast = forecastFixture();
    expect(forecast.id).toMatch(/^market_forecast_[a-f0-9]{48}$/);
    expect(forecast.probabilityState).toBe("uncalibrated");
    expect(forecast.scenarios.map((scenario) => scenario.direction)).toEqual([
      "bullish",
      "bearish",
      "neutral",
    ]);
    expect(forecast.warnings[0]).toContain("No calibrated probability");
    expect(forecast.evidence.baselineQualifiedGroups).toBe(0);
  });

  it("rejects invented detector evidence", () => {
    expect(() => forecastFixture({
      supportingFeatureIds: [`market_feature_${"9".repeat(48)}`],
    })).toThrow("outside its snapshot");
  });

  it("scores the sealed stance without inventing a Brier score", () => {
    const forecast = forecastFixture();
    const result = marketBarsProviderResultSchema.parse({
      contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
      instrumentId: "xauusd.spot",
      provider: "twelve_data",
      providerSymbol: "XAU/USD",
      providerTimezone: "UTC",
      interval: "15min",
      retrievedAt: "2026-09-15T20:05:00.000Z",
      asOf: "2026-09-15T20:00:00.000Z",
      bars: [
        bar("2026-09-15T13:30:00.000Z", 100, 101, 99, 100.5),
        bar("2026-09-15T20:00:00.000Z", 100.5, 103, 100, 102),
      ],
    });
    const outcome = scoreMarketForwardForecast({
      forecast,
      result,
      sourcePayload: { status: "ok", values: [] },
      resolvedAt: "2026-09-15T20:06:00.000Z",
    });
    expect(outcome.actualDirection).toBe("bullish");
    expect(outcome.stanceHit).toBe(true);
    expect(outcome.scenarioRankHit).toBe(1);
    expect(outcome.returnBps).toBeGreaterThan(0);
    expect(outcome.brierScore).toBeNull();
  });
});

function forecastFixture(options: { supportingFeatureIds?: string[] } = {}) {
  const snapshot = marketBarsResultSchema.parse({
    contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
    instrumentId: "xauusd.spot",
    provider: "twelve_data",
    providerSymbol: "XAU/USD",
    providerTimezone: "UTC",
    interval: "15min",
    retrievedAt: "2026-09-14T12:01:00.000Z",
    asOf: "2026-09-14T12:00:00.000Z",
    bars: [
      bar("2026-09-14T11:00:00.000Z", 99, 100, 98, 99.5),
      bar("2026-09-14T11:15:00.000Z", 99.5, 101, 99, 100.5),
      bar("2026-09-14T11:30:00.000Z", 100.5, 102, 100, 101),
      bar("2026-09-14T11:45:00.000Z", 101, 102, 99.5, 100),
      bar("2026-09-14T12:00:00.000Z", 100, 101, 99, 100.5),
    ],
    snapshotId: `market_snapshot_${"1".repeat(48)}`,
    snapshotSha256: "2".repeat(64),
    snapshotSource: "provider",
  });
  const features = buildMarketTechnicalFeatures(snapshot);
  const baselineBody = {
    contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
    baselineVersion: MARKET_EVENT_BASELINE_VERSION,
    instrumentId: "xauusd.spot",
    minimumSampleSize: 20,
    includedReplays: 0,
    groups: [],
    interpretation: "descriptive_not_predictive" as const,
  };
  const baselines = marketEventBaselinesResultSchema.parse({
    ...baselineBody,
    resultSha256: canonicalJsonSha256(baselineBody),
  });
  const supportingFeatureIds = options.supportingFeatureIds || [];
  return buildMarketForwardForecast({
    tenantId: "default",
    actorId: "owner@example.com",
    instrumentId: "xauusd.spot",
    horizon: "daily",
    window: {
      start: "2026-09-15T13:30:00.000Z",
      end: "2026-09-15T20:00:00.000Z",
    },
    sealedAt: "2026-09-14T12:05:00.000Z",
    features,
    baselines,
    macroEvents: [],
    modelOutput: {
      stance: "bullish",
      evidenceStrength: "limited",
      summary: "The bounded snapshot supports a guarded bullish lead while alternatives remain live.",
      scenarios: [
        scenario("bullish", 1, supportingFeatureIds),
        scenario("bearish", 2, []),
        scenario("neutral", 3, []),
      ],
      warnings: ["Consensus surprise data is unavailable."],
    },
    modelAttribution: {
      provider: "openai",
      model: "gpt-6-astra",
      assignmentScope: "market_research",
      assignmentId: "assignment-1",
      assignmentRevision: 1,
      assignmentConfigurationSha256: "3".repeat(64),
      usageReceiptId: "11111111-1111-4111-8111-111111111111",
      usageReceiptRecorded: true,
    },
  });
}

function scenario(
  direction: "bullish" | "bearish" | "neutral",
  rank: number,
  supportingFeatureIds: string[],
) {
  return {
    direction,
    rank,
    thesis: `${direction} research scenario`,
    observationZone: null,
    targets: [],
    invalidation: null,
    supportingFeatureIds,
  };
}

function bar(timestamp: string, open: number, high: number, low: number, close: number) {
  return {
    time: Date.parse(timestamp) / 1_000,
    timestamp,
    open,
    high,
    low,
    close,
    volume: null,
  };
}
