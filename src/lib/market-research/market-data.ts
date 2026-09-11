import "server-only";

import type {
  MarketBarsResult,
  MarketInterval,
  MarketInstrumentId,
} from "@/lib/market-research/contracts";
import { marketInstrument } from "@/lib/market-research/instruments";
import { fetchTwelveDataBars } from "@/lib/market-research/twelve-data";

export function fetchMarketBars(input: {
  instrumentId: MarketInstrumentId;
  interval: MarketInterval;
  outputSize: number;
}): Promise<MarketBarsResult> {
  const instrument = marketInstrument(input.instrumentId);
  if (instrument.providerMapping.provider !== "twelve_data") {
    throw new Error(`No active market-data adapter is registered for ${instrument.providerMapping.provider}.`);
  }
  return fetchTwelveDataBars(input);
}
