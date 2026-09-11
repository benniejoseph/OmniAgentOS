import { describe, expect, it, vi } from "vitest";

import {
  MARKET_RESEARCH_CONTRACT_VERSION,
  type MarketBarsResult,
} from "@/lib/market-research/contracts";
import { marketInstrument } from "@/lib/market-research/instruments";
import {
  createAsaelTradingViewDatafeed,
  createTradingViewSymbolInfo,
  marketIntervalToTradingViewResolution,
  type TradingViewMarketSnapshot,
} from "@/lib/market-research/tradingview-datafeed";

const bars: MarketBarsResult = {
  contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
  instrumentId: "xauusd.spot",
  provider: "twelve_data",
  providerSymbol: "XAU/USD",
  providerTimezone: "UTC",
  interval: "15min",
  retrievedAt: "2026-09-11T10:45:00.000Z",
  asOf: "2026-09-11T10:30:00.000Z",
  snapshotId: `market_snapshot_${"a".repeat(48)}`,
  snapshotSha256: "b".repeat(64),
  snapshotSource: "provider",
  bars: [
    marketBar(1_789_030_800, 3_650),
    marketBar(1_789_031_700, 3_655),
    marketBar(1_789_032_600, 3_660),
  ],
};

const snapshot: TradingViewMarketSnapshot = {
  instrument: marketInstrument("xauusd.spot"),
  bars,
};

describe("TradingView Advanced Charts datafeed", () => {
  it("maps only Asael's explicit evidence-bound intervals", () => {
    expect(marketIntervalToTradingViewResolution("5min")).toBe("5");
    expect(marketIntervalToTradingViewResolution("15min")).toBe("15");
    expect(marketIntervalToTradingViewResolution("1h")).toBe("60");
  });

  it("retains exact instrument and provider identity in symbol metadata", () => {
    expect(createTradingViewSymbolInfo(snapshot)).toMatchObject({
      name: "XAU/USD",
      ticker: "xauusd.spot",
      description: "Gold / U.S. dollar",
      exchange: "Twelve Data",
      timezone: "Etc/UTC",
      type: "forex",
    });
  });

  it("serves immutable snapshot bars in ascending time with milliseconds", async () => {
    const datafeed = createAsaelTradingViewDatafeed(() => snapshot);
    const onResult = vi.fn();
    datafeed.getBars(
      createTradingViewSymbolInfo(snapshot),
      "15",
      {
        from: bars.bars[0].time,
        to: bars.bars[2].time,
        countBack: 2,
        firstDataRequest: true,
      },
      onResult,
      vi.fn(),
    );
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce());
    expect(onResult.mock.calls[0][0]).toEqual([
      expect.objectContaining({ time: bars.bars[1].time * 1_000, close: 3_655 }),
      expect.objectContaining({ time: bars.bars[2].time * 1_000, close: 3_660 }),
    ]);
    expect(onResult.mock.calls[0][1]).toEqual({ noData: false });
  });

  it("rejects chart interval changes that did not load a new Asael snapshot", async () => {
    const datafeed = createAsaelTradingViewDatafeed(() => snapshot);
    const onError = vi.fn();
    datafeed.getBars(
      createTradingViewSymbolInfo(snapshot),
      "60",
      { from: 0, to: bars.bars[2].time, firstDataRequest: true },
      vi.fn(),
      onError,
    );
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("evidence-bound"));
  });
});

function marketBar(time: number, close: number) {
  return {
    time,
    timestamp: new Date(time * 1_000).toISOString(),
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: null,
  };
}
