import { describe, expect, it } from "vitest";

import {
  marketAnalysisGenerateRequestSchema,
  marketAnalysisVersionSchema,
  marketBarSchema,
} from "@/lib/market-research/contracts";
import { marketInstrument, marketInstruments } from "@/lib/market-research/instruments";

describe("market research foundation", () => {
  it("binds NAS100 research to the explicit Twelve Data NDX cash index", () => {
    const nasdaq = marketInstrument("ndx.cash");

    expect(nasdaq.canonicalSymbol).toBe("NDX");
    expect(nasdaq.aliases).toEqual(expect.arrayContaining(["NAS100", "US100"]));
    expect(nasdaq.providerMapping).toMatchObject({
      provider: "twelve_data",
      symbol: "NDX",
      status: "verified",
    });
    expect(nasdaq.identityWarning).toContain("NQ/MNQ");
    expect(nasdaq.identityWarning).toContain("QQQ");
  });

  it("admits both explicitly named research feeds without conflating them", () => {
    const verified = marketInstruments.filter((instrument) =>
      instrument.providerMapping.status === "verified"
    );

    expect(verified).toHaveLength(2);
    expect(verified[0]).toMatchObject({
      instrumentId: "xauusd.spot",
      providerMapping: { provider: "twelve_data", symbol: "XAU/USD" },
    });
    expect(verified[1]).toMatchObject({
      instrumentId: "ndx.cash",
      providerMapping: { provider: "twelve_data", symbol: "NDX" },
    });
  });

  it("rejects malformed OHLC bars instead of repairing provider data", () => {
    expect(() => marketBarSchema.parse({
      time: 1_789_000_000,
      timestamp: "2026-09-10T12:00:00.000Z",
      open: 4_000,
      high: 3_900,
      low: 3_850,
      close: 3_950,
      volume: null,
    })).toThrow(/OHLC bounds/i);
  });

  it("accepts bounded renderer state and rejects impossible version counts", () => {
    expect(marketAnalysisGenerateRequestSchema.parse({
      snapshotId: `market_snapshot_${"a".repeat(48)}`,
      visibleLayerIds: ["liquidity", "setups"],
      chartState: {
        sources: [["manual-drawing-1", { type: "trend_line" }]],
        groups: [],
        symbol: "xauusd.spot",
      },
    }).visibleLayerIds).toEqual(["liquidity", "setups"]);

    expect(() => marketAnalysisVersionSchema.parse({
      id: `market_analysis_${"a".repeat(48)}`,
      contractVersion: "market-analysis-version:1",
      instrumentId: "xauusd.spot",
      interval: "15min",
      snapshotId: `market_snapshot_${"b".repeat(48)}`,
      snapshotSha256: "c".repeat(64),
      detectorVersion: "market-ict-quarterly-candidates:2",
      technicalResultSha256: "d".repeat(64),
      visibleLayerIds: [],
      chartStateSha256: "e".repeat(64),
      chartState: { sources: null, groups: [] },
      annotationCount: 2,
      detectionCount: 1,
      candidateCount: 2,
      savedAt: "2026-09-12T05:00:00.000Z",
      versionSha256: "f".repeat(64),
    })).toThrow(/cannot exceed/i);
  });
});
