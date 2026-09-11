import { describe, expect, it } from "vitest";

import { marketBarSchema } from "@/lib/market-research/contracts";
import { marketInstrument, marketInstruments } from "@/lib/market-research/instruments";

describe("market research foundation", () => {
  it("keeps the Nasdaq benchmark separate from CFDs, futures, and ETFs", () => {
    const nasdaq = marketInstrument("nasdaq100.reference");

    expect(nasdaq.canonicalSymbol).toBe("NDX");
    expect(nasdaq.aliases).toEqual(expect.arrayContaining(["NAS100", "US100"]));
    expect(nasdaq.providerMapping).toMatchObject({
      symbol: null,
      status: "discovery_required",
    });
    expect(nasdaq.identityWarning).toContain("NQ/MNQ");
    expect(nasdaq.identityWarning).toContain("QQQ");
  });

  it("admits only the explicitly verified XAU/USD provider mapping", () => {
    const verified = marketInstruments.filter((instrument) =>
      instrument.providerMapping.status === "verified"
    );

    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({
      instrumentId: "xauusd.spot",
      providerMapping: { provider: "twelve_data", symbol: "XAU/USD" },
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
});
