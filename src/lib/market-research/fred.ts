import "server-only";

import { z } from "zod";

import type { HighImpactEventDefinition } from "@/lib/market-research/event-catalog";

const fredReleaseDatesResponseSchema = z.object({
  error_code: z.number().optional(),
  error_message: z.string().optional(),
  release_dates: z.array(z.object({
    release_id: z.number().int().positive(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).passthrough()).optional(),
}).passthrough();

export class FredCredentialRequiredError extends Error {
  constructor() {
    super("FRED is not configured. Add FRED_API_KEY to the deployment environment.");
    this.name = "FredCredentialRequiredError";
  }
}

export class FredProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FredProviderError";
  }
}

export type FredReleaseDate = {
  eventKey: string;
  name: string;
  releaseId: number;
  releaseDate: string;
  sourceUrl: string;
};

export async function fetchFredReleaseDates(input: {
  event: HighImpactEventDefinition;
  startDate: string;
  endDate: string;
  signal?: AbortSignal;
}): Promise<FredReleaseDate[]> {
  const apiKey = process.env.FRED_API_KEY?.trim();
  if (!apiKey) throw new FredCredentialRequiredError();

  const url = new URL("https://api.stlouisfed.org/fred/release/dates");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("release_id", String(input.event.fredReleaseId));
  url.searchParams.set("limit", "10000");
  url.searchParams.set("sort_order", "asc");
  url.searchParams.set("include_release_dates_with_no_data", "false");

  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new FredProviderError(
      error instanceof Error && error.name === "TimeoutError"
        ? "FRED did not respond before the macro-history timeout."
        : "FRED could not be reached.",
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new FredProviderError("FRED returned an unreadable response.");
  }
  const payload = fredReleaseDatesResponseSchema.parse(raw);
  if (!response.ok || payload.error_code || !payload.release_dates) {
    const safe = payload.error_message?.replace(/[\r\n\t]+/g, " ").trim()
      .slice(0, 220);
    throw new FredProviderError(
      response.status === 429
        ? "FRED rate limit reached. The backfill can be resumed later."
        : safe || `FRED returned HTTP ${response.status}.`,
    );
  }
  return payload.release_dates
    .filter(({ date, release_id: releaseId }) =>
      releaseId === input.event.fredReleaseId &&
      date >= input.startDate &&
      date <= input.endDate
    )
    .map(({ date }) => ({
      eventKey: input.event.eventKey,
      name: input.event.name,
      releaseId: input.event.fredReleaseId,
      releaseDate: date,
      sourceUrl: input.event.sourceUrl,
    }));
}
