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
    instrumentId: "nasdaq100.reference",
    label: "Nasdaq-100 reference index",
    shortLabel: "Nasdaq-100",
    canonicalSymbol: "NDX",
    assetClass: "equity_index",
    aliases: ["NDX", "NAS100", "US100"],
    description: "The Nasdaq-100 cash benchmark used as the reference identity for research.",
    identityWarning: "NDX, NQ/MNQ futures, QQQ, and broker-specific NAS100/US100 CFDs are separate instruments. A broker/feed mapping is required before replay or forecasting.",
    providerMapping: {
      provider: "twelve_data",
      symbol: null,
      status: "discovery_required",
      note: "The exact research and execution feed must be selected and verified; no proxy is substituted silently.",
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
