import "server-only";

import { z } from "zod";

import {
  MARKET_RESEARCH_CONTRACT_VERSION,
  marketBarsResultSchema,
  type MarketBarsResult,
  type MarketInterval,
  type MarketInstrumentId,
} from "@/lib/market-research/contracts";
import { marketInstrument } from "@/lib/market-research/instruments";

const twelveDataValueSchema = z.object({
  datetime: z.string().min(1).max(80),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volume: z.string().nullish(),
}).passthrough();

const twelveDataResponseSchema = z.object({
  status: z.string().optional(),
  code: z.number().optional(),
  message: z.string().optional(),
  meta: z.object({
    symbol: z.string().min(1),
    timezone: z.string().min(1).default("UTC"),
  }).passthrough().optional(),
  values: z.array(twelveDataValueSchema).optional(),
}).passthrough();

export class MarketDataCredentialRequiredError extends Error {
  constructor(
    provider = "Twelve Data",
    setupVariable = "TWELVE_DATA_API_KEY",
  ) {
    super(`${provider} is not configured. Add ${setupVariable} to the deployment environment.`);
    this.name = "MarketDataCredentialRequiredError";
  }
}

export class MarketInstrumentMappingRequiredError extends Error {
  constructor(instrumentId: MarketInstrumentId) {
    super(`The exact provider mapping for ${instrumentId} must be verified before market data can be requested.`);
    this.name = "MarketInstrumentMappingRequiredError";
  }
}

export class MarketDataProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketDataProviderError";
  }
}

export async function fetchTwelveDataBars(input: {
  instrumentId: MarketInstrumentId;
  interval: MarketInterval;
  outputSize: number;
}): Promise<MarketBarsResult> {
  const apiKey = process.env.TWELVE_DATA_API_KEY?.trim();
  if (!apiKey) throw new MarketDataCredentialRequiredError();
  const instrument = marketInstrument(input.instrumentId);
  const mapping = instrument.providerMapping;
  if (
    mapping.provider !== "twelve_data" ||
    mapping.status !== "verified" ||
    !mapping.symbol
  ) {
    throw new MarketInstrumentMappingRequiredError(input.instrumentId);
  }

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", mapping.symbol);
  url.searchParams.set("interval", input.interval);
  url.searchParams.set("outputsize", String(input.outputSize));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("format", "JSON");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `apikey ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    throw new MarketDataProviderError(
      error instanceof Error && error.name === "TimeoutError"
        ? "Twelve Data did not respond before the research timeout."
        : "Twelve Data could not be reached.",
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new MarketDataProviderError("Twelve Data returned an unreadable response.");
  }
  const payload = twelveDataResponseSchema.parse(raw);
  if (!response.ok || payload.status === "error" || !payload.meta || !payload.values) {
    throw new MarketDataProviderError(
      providerMessage(payload.message, response.status, mapping.symbol),
    );
  }

  const bars = payload.values.map((value) => {
    const timestamp = utcTimestamp(value.datetime);
    return {
      time: Math.floor(Date.parse(timestamp) / 1_000),
      timestamp,
      open: finiteNumber(value.open, "open"),
      high: finiteNumber(value.high, "high"),
      low: finiteNumber(value.low, "low"),
      close: finiteNumber(value.close, "close"),
      volume: value.volume === null || value.volume === undefined || value.volume === ""
        ? null
        : finiteNumber(value.volume, "volume"),
    };
  }).sort((left, right) => left.time - right.time);
  const asOf = bars.at(-1)?.timestamp;
  if (!asOf) throw new MarketDataProviderError("Twelve Data returned no market bars.");

  return marketBarsResultSchema.parse({
    contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
    instrumentId: input.instrumentId,
    provider: "twelve_data",
    providerSymbol: payload.meta.symbol,
    providerTimezone: payload.meta.timezone,
    interval: input.interval,
    retrievedAt: new Date().toISOString(),
    asOf,
    bars,
  });
}

function utcTimestamp(value: string) {
  const normalized = value.trim().replace(" ", "T");
  const timestamp = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new MarketDataProviderError("Twelve Data returned an invalid bar timestamp.");
  }
  return date.toISOString();
}

function finiteNumber(value: string, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new MarketDataProviderError(`Twelve Data returned an invalid ${field} value.`);
  }
  return parsed;
}

function providerMessage(
  message: string | undefined,
  status: number,
  providerSymbol: string,
) {
  if (status === 429) return "Twelve Data rate limit reached. Try again after the provider window resets.";
  if (status === 401 || status === 403) return "Twelve Data rejected the configured credential or entitlement.";
  const safe = message?.replace(/[\r\n\t]+/g, " ").trim().slice(0, 240);
  if (/available starting with the .*plan|consider upgrading/i.test(safe || "")) {
    return `Twelve Data recognizes ${providerSymbol}, but the current account does not include its time-series entitlement. ${safe}`;
  }
  return safe || `Twelve Data returned HTTP ${status}.`;
}
