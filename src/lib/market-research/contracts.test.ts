import { describe, expect, it } from "vitest";

import { marketBarSchema } from "@/lib/market-research/contracts";
import { marketInstrument, marketInstruments } from "@/lib/market-research/instruments";

describe("market research foundation", () => {
  it("binds NAS100 to the explicit TraderMade research CFD", () => {
    const nasdaq = marketInstrument("nas100.tradermade_cfd");

    expect(nasdaq.canonicalSymbol).toBe("NAS100");
    expect(nasdaq.aliases).toEqual(expect.arrayContaining(["NAS100", "US100"]));
    expect(nasdaq.providerMapping).toMatchObject({
      provider: "trader_made",
      symbol: "NAS100",
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
      instrumentId: "nas100.tradermade_cfd",
      providerMapping: { provider: "trader_made", symbol: "NAS100" },
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
