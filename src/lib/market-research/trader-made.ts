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
import {
  MarketDataCredentialRequiredError,
  MarketDataProviderError,
  MarketInstrumentMappingRequiredError,
} from "@/lib/market-research/twelve-data";

const quoteSchema = z.object({
  date: z.string().min(1).max(100),
  open: z.union([z.number(), z.string()]),
  high: z.union([z.number(), z.string()]),
  low: z.union([z.number(), z.string()]),
  close: z.union([z.number(), z.string()]),
}).passthrough();

const responseSchema = z.object({
  error: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  message: z.string().optional(),
  quotes: z.array(quoteSchema).optional(),
}).passthrough();

export async function fetchTraderMadeBars(input: {
  instrumentId: MarketInstrumentId;
  interval: MarketInterval;
  outputSize: number;
}): Promise<MarketBarsResult> {
  const apiKey = process.env.TRADERMADE_REST_API_KEY?.trim();
  if (!apiKey) {
    throw new MarketDataCredentialRequiredError(
      "TraderMade REST",
      "TRADERMADE_REST_API_KEY",
    );
  }
  const instrument = marketInstrument(input.instrumentId);
  const mapping = instrument.providerMapping;
  if (
    mapping.provider !== "trader_made" ||
    mapping.status !== "verified" ||
    !mapping.symbol
  ) {
    throw new MarketInstrumentMappingRequiredError(input.instrumentId);
  }

  const range = traderMadeRange(input.interval, input.outputSize);
  const url = new URL("https://marketdata.tradermade.com/api/v1/timeseries");
  url.searchParams.set("currency", mapping.symbol);
  url.searchParams.set("start_date", range.startDate);
  url.searchParams.set("end_date", range.endDate);
  url.searchParams.set("interval", range.interval);
  url.searchParams.set("period", range.period);
  url.searchParams.set("format", "records");
  // TraderMade's REST contract accepts the credential only as api_key.
  url.searchParams.set("api_key", apiKey);

  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    throw new MarketDataProviderError(
      error instanceof Error && error.name === "TimeoutError"
        ? "TraderMade did not respond before the research timeout."
        : "TraderMade could not be reached.",
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new MarketDataProviderError("TraderMade returned an unreadable response.");
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MarketDataProviderError("TraderMade returned an unsupported response shape.");
  }
  if (!response.ok || parsed.data.error || !parsed.data.quotes) {
    throw new MarketDataProviderError(
      traderMadeError(parsed.data.error, parsed.data.message, response.status),
    );
  }

  const bars = parsed.data.quotes.map((quote) => {
    const timestamp = utcTimestamp(quote.date);
    return {
      time: Math.floor(Date.parse(timestamp) / 1_000),
      timestamp,
      open: finiteNumber(quote.open, "open"),
      high: finiteNumber(quote.high, "high"),
      low: finiteNumber(quote.low, "low"),
      close: finiteNumber(quote.close, "close"),
      volume: null,
    };
  }).sort((left, right) => left.time - right.time).slice(-input.outputSize);
  const asOf = bars.at(-1)?.timestamp;
  if (!asOf) throw new MarketDataProviderError("TraderMade returned no market bars.");

  return marketBarsResultSchema.parse({
    contractVersion: MARKET_RESEARCH_CONTRACT_VERSION,
    instrumentId: input.instrumentId,
    provider: "trader_made",
    providerSymbol: mapping.symbol,
    providerTimezone: "UTC",
    interval: input.interval,
    retrievedAt: new Date().toISOString(),
    asOf,
    bars,
  });
}

function traderMadeRange(interval: MarketInterval, outputSize: number) {
  const end = new Date();
  const spec = interval === "1h"
    ? { interval: "hourly", period: "1", stepMs: 60 * 60 * 1_000, maxMs: 30 * 86_400_000 }
    : { interval: "minute", period: interval === "5min" ? "5" : "15", stepMs: (interval === "5min" ? 5 : 15) * 60_000, maxMs: 2 * 86_400_000 };
  const requestedMs = Math.max(spec.stepMs * outputSize * 1.6, spec.stepMs * 100);
  const start = new Date(end.getTime() - Math.min(requestedMs, spec.maxMs));
  return {
    interval: spec.interval,
    period: spec.period,
    startDate: providerDate(start),
    endDate: providerDate(end),
  };
}

function providerDate(value: Date) {
  return value.toISOString().slice(0, 16).replace("T", "-");
}

function utcTimestamp(value: string) {
  const normalized = value.trim().replace(" ", "T");
  const timestamp = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new MarketDataProviderError("TraderMade returned an invalid bar timestamp.");
  }
  return date.toISOString();
}

function finiteNumber(value: number | string, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new MarketDataProviderError(`TraderMade returned an invalid ${field} value.`);
  }
  return parsed;
}

function traderMadeError(
  error: string | Record<string, unknown> | undefined,
  message: string | undefined,
  status: number,
) {
  const raw = typeof error === "string"
    ? error
    : typeof message === "string"
      ? message
      : "";
  const safe = raw.replace(/[\r\n\t]+/g, " ").trim().slice(0, 180);
  if (/dataset_not_in_plan|not.in.plan|entitlement/i.test(safe)) {
    return "TraderMade authenticated, but NAS100 is not included in the current REST data plan.";
  }
  if (status === 401 || status === 403 || /api.?key|auth/i.test(safe)) {
    return "TraderMade rejected the configured REST credential.";
  }
  if (status === 429) return "TraderMade rate limit reached. Try again after the provider window resets.";
  return safe || `TraderMade returned HTTP ${status}.`;
}
