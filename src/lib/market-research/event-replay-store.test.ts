import { describe, expect, it } from "vitest";

import {
  MARKET_RESEARCH_CONTRACT_VERSION,
  type MarketBarsProviderResult,
} from "@/lib/market-research/contracts";
import { buildMarketEventReplay } from "@/lib/market-research/event-replay-store";

function providerResult(): MarketBarsProviderResult {
  const start = Date.parse("2026-09-11T11:25:00.000Z");
  const bars = Array.from({ length: 72 }, (_, index) => {
    const time = start + index * 5 * 60_000;
    const afterEvent = time >= Date.parse("2026-09-11T12:30:00.000Z");
    const close = afterEvent ? 100 + (index - 12) * 0.1 : 100;
    return {
      time: Math.floor(time / 1_000),
      timestamp: new Date(time).toISOString(),
      open: close - 0.02,
      high: close + 0.05,
      low: close - 0.05,
      close,
      volume: null,
    };
  });
  return {
    contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
    instrumentId: "xauusd.spot",
    provider: "twelve_data",
    providerSymbol: "XAU/USD",
    providerTimezone: "UTC",
    interval: "5min",
    retrievedAt: "2026-09-11T16:30:00.000Z",
    asOf: bars.at(-1)!.timestamp,
    bars,
  };
}

describe("market event replay metrics", () => {
  it("uses the last completed pre-event bar and causal post-event closes", () => {
    const replay = buildMarketEventReplay({
      tenantId: "tenant-a",
      actorId: "actor-a",
      event: {
        eventId: `market_event_${"a".repeat(48)}`,
        eventKey: "us.cpi",
        occurredAt: "2026-09-11T12:30:00.000Z",
      },
      windowStart: "2026-09-11T11:00:00.000Z",
      windowEnd: "2026-09-11T17:00:00.000Z",
      result: providerResult(),
    });

    expect(replay.baseline).toEqual({
      timestamp: "2026-09-11T12:25:00.000Z",
      close: 100,
    });
    expect(replay.post5m?.timestamp).toBe("2026-09-11T12:30:00.000Z");
    expect(replay.post60m?.returnBps).toBeGreaterThan(100);
    expect(replay.direction).toBe("up");
    expect(replay.maxFavorableBps).toBeGreaterThan(replay.post60m!.returnBps);
    expect(replay.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds replay identity to the exact owner and immutable bar content", () => {
    const common = {
      tenantId: "tenant-a",
      event: {
        eventId: `market_event_${"b".repeat(48)}`,
        eventKey: "us.fomc",
        occurredAt: "2026-09-11T12:30:00.000Z",
      },
      windowStart: "2026-09-11T11:00:00.000Z",
      windowEnd: "2026-09-11T17:00:00.000Z",
      result: providerResult(),
    };
    const first = buildMarketEventReplay({ ...common, actorId: "actor-a" });
    const sibling = buildMarketEventReplay({ ...common, actorId: "actor-b" });
    expect(sibling.snapshotSha256).toBe(first.snapshotSha256);
    expect(sibling.id).not.toBe(first.id);
  });
});
