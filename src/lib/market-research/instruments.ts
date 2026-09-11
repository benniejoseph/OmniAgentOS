import {
  marketInstrumentSchema,
  type MarketInstrument,
  type MarketInstrumentId,
} from "@/lib/market-research/contracts";

export const marketInstruments: readonly MarketInstrument[] = Object.freeze([
  marketInstrumentSchema.parse({
    instrumentId: "xauusd.spot",
    label: "Gold / U.S. dollar",
    shortLabel: "XAU/USD",
    canonicalSymbol: "XAU/USD",
    assetClass: "commodity_spot",
    aliases: ["XAUUSD", "GOLD"],
    description: "Indicative spot gold priced in U.S. dollars for research and chart context.",
    identityWarning: "This is not CME GC/MGC futures and is not a broker-executable quote. Spreads and session bars can differ by venue.",
    providerMapping: {
      provider: "twelve_data",
      symbol: "XAU/USD",
      status: "verified",
      note: "Twelve Data documents XAU/USD support; its aggregated midpoint data remains indicative.",
    },
  }),
  marketInstrumentSchema.parse({
    instrumentId: "nas100.tradermade_cfd",
    label: "Nasdaq-100 research CFD",
    shortLabel: "NAS100",
    canonicalSymbol: "NAS100",
    assetClass: "cfd",
    aliases: ["NDX", "NAS100", "US100"],
    description: "TraderMade's aggregated Nasdaq-100 CFD research feed, kept separate from the cash index, futures, ETFs, and any broker execution quote.",
    identityWarning: "This NAS100 feed is an aggregated research CFD, not NDX, NQ/MNQ, QQQ, or your broker's executable US100 quote. Spreads, sessions, and prices can differ.",
    providerMapping: {
      provider: "trader_made",
      symbol: "NAS100",
      status: "verified",
      note: "TraderMade publishes NAS100 as an index CFD symbol. Availability still depends on the connected account's CFD entitlement.",
    },
  }),
]);

export function marketInstrument(instrumentId: MarketInstrumentId) {
  const instrument = marketInstruments.find((candidate) =>
    candidate.instrumentId === instrumentId
  );
  if (!instrument) throw new Error(`Market instrument ${instrumentId} is unavailable.`);
  return instrument;
}
