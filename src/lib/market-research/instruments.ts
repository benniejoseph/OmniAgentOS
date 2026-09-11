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
    instrumentId: "ndx.cash",
    label: "Nasdaq-100 cash index",
    shortLabel: "NDX / NAS100",
    canonicalSymbol: "NDX",
    assetClass: "equity_index",
    aliases: ["NDX", "NAS100", "US100"],
    description: "The Nasdaq-100 cash index supplied by Twelve Data under NDX, displayed with the familiar NAS100 alias for research.",
    identityWarning: "This is the NDX cash index, not NQ/MNQ futures, QQQ, or your broker's executable NAS100/US100 CFD. Sessions, spreads, and prices can differ.",
    providerMapping: {
      provider: "twelve_data",
      symbol: "NDX",
      status: "verified",
      note: "Twelve Data recognizes NDX but currently reports that this account needs its Grow or Venture entitlement for time-series access.",
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
