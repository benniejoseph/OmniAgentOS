import "server-only";

import type {
  MarketBarsResult,
  MarketInterval,
  MarketInstrumentId,
} from "@/lib/market-research/contracts";
import { marketInstrument } from "@/lib/market-research/instruments";
import { fetchTraderMadeBars } from "@/lib/market-research/trader-made";
import { fetchTwelveDataBars } from "@/lib/market-research/twelve-data";

export function fetchMarketBars(input: {
  instrumentId: MarketInstrumentId;
  interval: MarketInterval;
  outputSize: number;
}): Promise<MarketBarsResult> {
  const instrument = marketInstrument(input.instrumentId);
  return instrument.providerMapping.provider === "trader_made"
    ? fetchTraderMadeBars(input)
    : fetchTwelveDataBars(input);
}
