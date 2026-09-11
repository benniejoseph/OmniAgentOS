import { describe, expect, it } from "vitest";

import {
  MARKET_RESEARCH_CONTRACT_VERSION,
  type MarketBarsProviderResult,
} from "@/lib/market-research/contracts";
import { marketPriceSnapshotIdentity } from "@/lib/market-research/price-snapshot-store";

const providerResult: MarketBarsProviderResult = {
  contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
  instrumentId: "xauusd.spot",
  provider: "twelve_data",
  providerSymbol: "XAU/USD",
  providerTimezone: "UTC",
  interval: "15min",
  retrievedAt: "2026-09-11T12:01:00.000Z",
  asOf: "2026-09-11T12:00:00.000Z",
  bars: [{
    time: 1_788_782_400,
    timestamp: "2026-09-11T12:00:00.000Z",
    open: 3_600,
    high: 3_604,
    low: 3_598,
    close: 3_602,
    volume: null,
  }],
};

describe("market price snapshot identity", () => {
  it("is stable across retrieval time but changes with content or owner", () => {
    const first = marketPriceSnapshotIdentity({
      tenantId: "tenant-a",
      actorId: "actor-a",
      result: providerResult,
    });
    const later = marketPriceSnapshotIdentity({
      tenantId: "tenant-a",
      actorId: "actor-a",
      result: {
        ...providerResult,
        retrievedAt: "2026-09-11T12:02:00.000Z",
      },
    });
    const changed = marketPriceSnapshotIdentity({
      tenantId: "tenant-a",
      actorId: "actor-a",
      result: {
        ...providerResult,
        bars: [{ ...providerResult.bars[0], close: 3_603 }],
      },
    });
    const otherOwner = marketPriceSnapshotIdentity({
      tenantId: "tenant-a",
      actorId: "actor-b",
      result: providerResult,
    });

    expect(later).toEqual(first);
    expect(changed.snapshotSha256).not.toBe(first.snapshotSha256);
    expect(changed.snapshotId).not.toBe(first.snapshotId);
    expect(otherOwner.snapshotSha256).toBe(first.snapshotSha256);
    expect(otherOwner.snapshotId).not.toBe(first.snapshotId);
  });
});
