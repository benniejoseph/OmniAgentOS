import { describe, expect, it } from "vitest";

import type { MarketBar, MarketBarsResult } from "@/lib/market-research/contracts";
import {
  buildMarketTechnicalFeatures,
  MarketTechnicalInsufficientDataError,
} from "@/lib/market-research/technical-features";

describe("deterministic market technical primitives", () => {
  it("derives versioned features from one immutable snapshot without model inference", () => {
    const result = buildMarketTechnicalFeatures(snapshot());

    expect(result.snapshot.id).toBe(`market_snapshot_${"a".repeat(48)}`);
    expect(result.detectorVersion).toBe("market-ict-quarterly-candidates:2");
    expect(result.detections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "displacement",
        direction: "bullish",
      }),
      expect.objectContaining({
        kind: "fair_value_gap",
        direction: "bullish",
        state: "active",
      }),
      expect.objectContaining({
        kind: "liquidity_sweep",
        direction: "bearish",
      }),
    ]));
    expect(result.definitions.every((definition) =>
      definition.reviewState === "deterministic_foundation"
        ? definition.transcriptAuthority === "not_claimed"
        : definition.transcriptAuthority === "awaiting_review"
    )).toBe(true);
    expect(result.definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "candidate.order_block.v1" }),
      expect.objectContaining({ id: "candidate.turtle_soup.v1" }),
      expect.objectContaining({ id: "candidate.unicorn.v1" }),
      expect.objectContaining({ id: "candidate.judas_swing.v1" }),
    ]));
    expect(result.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "liquidity", defaultVisible: true }),
      expect.objectContaining({ id: "imbalances", defaultVisible: true }),
      expect.objectContaining({ id: "sessions", defaultVisible: false }),
      expect.objectContaining({ id: "quarterly", defaultVisible: false }),
      expect.objectContaining({ id: "structure", defaultVisible: false }),
    ]));
    expect(result.annotations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        concept: "fair_value_gap",
        layerId: "imbalances",
        primitive: expect.objectContaining({ type: "price_zone" }),
      }),
      expect.objectContaining({
        concept: "session_killzone",
        layerId: "sessions",
        primitive: expect.objectContaining({ type: "time_window" }),
      }),
    ]));
    expect(result.resultSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("replays the same snapshot and detector version to the same digest", () => {
    const first = buildMarketTechnicalFeatures(snapshot());
    const second = buildMarketTechnicalFeatures(structuredClone(snapshot()));

    expect(second).toEqual(first);
  });

  it("reports opening references only when the immutable snapshot contains the boundary", () => {
    const result = buildMarketTechnicalFeatures(snapshot());
    const references = Object.fromEntries(
      result.timeContext.references.map((reference) => [reference.id, reference]),
    );

    expect(references.ninety_minute.status).toBe("available");
    expect(references.ninety_minute.open).not.toBeNull();
    expect(references.day).toMatchObject({
      status: "outside_snapshot",
      open: null,
    });
  });

  it("fails closed when a snapshot is too small to support its definitions", () => {
    const value = snapshot();
    value.bars = value.bars.slice(0, 4);

    expect(() => buildMarketTechnicalFeatures(value)).toThrow(
      MarketTechnicalInsufficientDataError,
    );
  });
});

function snapshot(): MarketBarsResult {
  const start = Date.parse("2026-09-10T12:00:00.000Z");
  const bars = Array.from({ length: 30 }, (_, index): MarketBar => {
    const center = 100 + (index % 2 === 0 ? 0.05 : -0.05);
    return bar(start, index, center, center + 0.2, center - 0.2, center + 0.05);
  });

  bars[20] = bar(start, 20, 100, 103, 99.9, 102.8);
  bars[21] = bar(start, 21, 102.8, 104, 102.6, 103.8);
  bars[22] = bar(start, 22, 103.5, 104.5, 103.2, 104.2);
  bars[23] = bar(start, 23, 104.2, 104.6, 103.9, 104.3);
  bars[24] = bar(start, 24, 104.3, 104.7, 104, 104.4);
  bars[25] = bar(start, 25, 104.4, 105.2, 103.8, 104.1);
  bars[26] = bar(start, 26, 104.1, 104.6, 103.9, 104.3);
  bars[27] = bar(start, 27, 104.3, 104.7, 104, 104.5);
  bars[28] = bar(start, 28, 104.5, 104.9, 104.1, 104.6);
  bars[29] = bar(start, 29, 104.6, 105, 104.2, 104.7);

  return {
    contractVersion: "market-research-foundation:6",
    instrumentId: "xauusd.spot",
    provider: "twelve_data",
    providerSymbol: "XAU/USD",
    providerTimezone: "UTC",
    interval: "5min",
    retrievedAt: "2026-09-10T14:30:00.000Z",
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
