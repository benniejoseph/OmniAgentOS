import "server-only";

import type {
  MarketInterval,
  MarketInstrumentId,
} from "@/lib/market-research/contracts";
import { marketInstrument } from "@/lib/market-research/instruments";
import {
  fetchTwelveDataBarSnapshot,
  type TwelveDataBarSnapshot,
} from "@/lib/market-research/twelve-data";

export function fetchMarketBarSnapshot(input: {
  instrumentId: MarketInstrumentId;
  interval: MarketInterval;
  outputSize: number;
}): Promise<TwelveDataBarSnapshot> {
  const instrument = marketInstrument(input.instrumentId);
  if (instrument.providerMapping.provider !== "twelve_data") {
    throw new Error(`No active market-data adapter is registered for ${instrument.providerMapping.provider}.`);
  }
  return fetchTwelveDataBarSnapshot(input);
}
