import { describe, expect, it } from "vitest";

import type { MarketEventReplay } from "@/lib/market-research/contracts";
import { buildMarketEventBaselines } from "@/lib/market-research/event-baselines";

describe("market event descriptive baselines", () => {
  it("groups immutable outcomes without presenting them as predictive probabilities", () => {
    const result = buildMarketEventBaselines({
      instrumentId: "xauusd.spot",
      minimumSampleSize: 5,
      replays: [
        replay("us.cpi", "2026-01-10T13:30:00.000Z", 20),
        replay("us.cpi", "2026-02-10T13:30:00.000Z", -10),
        replay("us.cpi", "2026-03-10T13:30:00.000Z", 40),
        replay("us.cpi", "2026-04-10T13:30:00.000Z", -30),
        replay("us.cpi", "2026-05-10T13:30:00.000Z", 80),
        replay("us.ppi", "2026-05-11T13:30:00.000Z", 12),
      ],
    });

    expect(result.interpretation).toBe("descriptive_not_predictive");
    expect(result.groups[0]).toMatchObject({
      eventKey: "us.cpi",
      sampleSize: 5,
      state: "descriptive_baseline",
      directions: { up: 3, down: 2, flat: 0 },
      empiricalRates: { up: 0.6, down: 0.4, flat: 0 },
      post60m: {
        sampleSize: 5,
        medianBps: 20,
        lowerQuartileBps: -10,
        upperQuartileBps: 40,
      },
    });
    expect(result.groups[1]).toMatchObject({
      eventKey: "us.ppi",
      sampleSize: 1,
      state: "low_sample",
    });
  });

  it("is order-invariant for the same immutable replay cohort", () => {
    const replays = [
      replay("us.cpi", "2026-01-10T13:30:00.000Z", 20),
      replay("us.cpi", "2026-02-10T13:30:00.000Z", -10),
      replay("us.ppi", "2026-03-10T13:30:00.000Z", 5),
    ];
    const input = { instrumentId: "xauusd.spot", minimumSampleSize: 5 };

    expect(buildMarketEventBaselines({ ...input, replays: [...replays].reverse() }))
      .toEqual(buildMarketEventBaselines({ ...input, replays }));
  });

  it("rejects cross-instrument replay input", () => {
    expect(() => buildMarketEventBaselines({
      instrumentId: "ndx.cash",
      minimumSampleSize: 5,
      replays: [replay("us.cpi", "2026-01-10T13:30:00.000Z", 20)],
    })).toThrow(/instrument/i);
  });
});

function replay(
  eventKey: string,
  occurredAt: string,
  return60m: number,
): MarketEventReplay {
  const marker = `${eventKey}-${occurredAt}`.replace(/[^a-f0-9]/g, "a").slice(0, 48).padEnd(48, "b");
  const direction = return60m > 0 ? "up" : return60m < 0 ? "down" : "flat";
  return {
    id: `market_replay_${marker}`,
    eventId: `market_event_${marker}`,
    eventKey,
    instrumentId: "xauusd.spot",
    provider: "twelve_data",
    providerSymbol: "XAU/USD",
    interval: "5min",
    occurredAt,
    windowStart: new Date(Date.parse(occurredAt) - 60 * 60_000).toISOString(),
    windowEnd: new Date(Date.parse(occurredAt) + 4 * 60 * 60_000).toISOString(),
    retrievedAt: "2026-09-11T00:00:00.000Z",
    barCount: 61,
    snapshotSha256: "a".repeat(64),
    baseline: { timestamp: occurredAt, close: 4_000 },
    post5m: point(occurredAt, return60m / 4),
    post15m: point(occurredAt, return60m / 2),
    post60m: point(occurredAt, return60m),
    post240m: point(occurredAt, return60m * 1.5),
    pre60mRangeBps: 25,
    post60mRangeBps: 50,
    maxFavorableBps: Math.max(0, return60m) + 10,
    maxAdverseBps: Math.max(0, -return60m) + 8,
    direction,
  };
}

function point(timestamp: string, returnBps: number) {
  return { timestamp, close: 4_000 * (1 + returnBps / 10_000), returnBps };
}
