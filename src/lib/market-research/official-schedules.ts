import "server-only";

import { z } from "zod";

import type { HighImpactEventDefinition } from "@/lib/market-research/event-catalog";

export const OFFICIAL_MARKET_SCHEDULE_SOURCES = [
  "bls",
  "census",
  "bea",
  "federal_reserve",
] as const;

export type OfficialMarketScheduleSource =
  (typeof OFFICIAL_MARKET_SCHEDULE_SOURCES)[number];

export const officialMarketScheduleEntrySchema = z.object({
  source: z.enum(OFFICIAL_MARKET_SCHEDULE_SOURCES),
  eventKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  name: z.string().min(1).max(160),
  sourceUid: z.string().min(1).max(500),
  sourceUrl: z.string().url(),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  occurredAt: z.string().datetime({ offset: true }),
  timezone: z.literal("America/New_York"),
}).strict();

export type OfficialMarketScheduleEntry = z.infer<
  typeof officialMarketScheduleEntrySchema
>;

export class OfficialScheduleProviderError extends Error {
  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
    this.name = "OfficialScheduleProviderError";
  }
}

export async function fetchCensusReleaseSchedule(input: {
  events: readonly HighImpactEventDefinition[];
  startDate: string;
  endDate: string;
  signal?: AbortSignal;
}) {
  const event = input.events.find(({ eventKey }) => eventKey === "us.retail_sales");
  if (!event) return [];
  const sourceUrl = "https://www.census.gov/economic-indicators/calendar-listview.html";
  const html = await fetchOfficialHtml("Census", sourceUrl, input.signal);
  return parseCensusSchedule(html, event).filter((entry) =>
    entry.releaseDate >= input.startDate && entry.releaseDate <= input.endDate
  );
}

export async function fetchBeaReleaseSchedule(input: {
  events: readonly HighImpactEventDefinition[];
  startDate: string;
  endDate: string;
  signal?: AbortSignal;
}) {
  const relevant = input.events.filter(({ eventKey }) =>
    eventKey === "us.gdp" || eventKey === "us.personal_income_outlays"
  );
  if (!relevant.length) return [];
  const sourceUrl = "https://www.bea.gov/news/schedule/full";
  const html = await fetchOfficialHtml("BEA", sourceUrl, input.signal);
  return parseBeaSchedule(html, relevant).filter((entry) =>
    entry.releaseDate >= input.startDate && entry.releaseDate <= input.endDate
  );
}

export async function fetchFederalReserveReleaseSchedule(input: {
  events: readonly HighImpactEventDefinition[];
  startDate: string;
  endDate: string;
  signal?: AbortSignal;
}) {
  const event = input.events.find(({ eventKey }) => eventKey === "us.fomc");
  if (!event) return [];
  const sourceUrl = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
  const html = await fetchOfficialHtml("Federal Reserve", sourceUrl, input.signal);
  return parseFederalReserveSchedule(html, event).filter((entry) =>
    entry.releaseDate >= input.startDate && entry.releaseDate <= input.endDate
  );
}

export function parseCensusSchedule(
  html: string,
  event: HighImpactEventDefinition,
) {
  const entries: OfficialMarketScheduleEntry[] = [];
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    if (!/Advance Monthly Sales for Retail and Food Services/i.test(row)) {
      continue;
    }
    const timestamp = row.match(/sorttable_customkey=["'](\d{12})["']/i)?.[1];
    if (!timestamp) continue;
    const local = compactDateTime(timestamp);
    entries.push(officialMarketScheduleEntrySchema.parse({
      source: "census",
      eventKey: event.eventKey,
      name: event.name,
      sourceUid: `census-retail:${timestamp}`,
      sourceUrl: "https://www.census.gov/retail/",
      releaseDate: dateFromParts(local),
      occurredAt: zonedDateTimeToIso(local, "America/New_York"),
      timezone: "America/New_York",
    }));
  }
  return uniqueSorted(entries);
}

export function parseBeaSchedule(
  html: string,
  events: readonly HighImpactEventDefinition[],
) {
  const year = Number(html.match(/>Year\s+(\d{4})</i)?.[1]);
  if (!Number.isInteger(year)) return [];
  const definitions = new Map(events.map((event) => [event.eventKey, event]));
  const entries: OfficialMarketScheduleEntry[] = [];
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const title = cleanHtml(
      row.match(/<td\b[^>]*class=["'][^"']*release-title[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] || "",
    );
    const eventKey = /^Gross Domestic Product,/i.test(title)
      ? "us.gdp"
      : /^Personal Income and Outlays,/i.test(title)
        ? "us.personal_income_outlays"
        : null;
    const event = eventKey ? definitions.get(eventKey) : undefined;
    if (!event) continue;
    const dateText = cleanHtml(
      row.match(/<div\b[^>]*class=["'][^"']*release-date[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "",
    );
    const timeText = cleanHtml(
      row.match(/<small\b[^>]*>([\s\S]*?)<\/small>/i)?.[1] || "",
    );
    const local = parseNamedDateTime(year, dateText, timeText);
    if (!local) continue;
    const path = row.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*View\s*<\/a>/i)?.[1];
    const sourceUrl = path
      ? new URL(path, "https://www.bea.gov").toString()
      : "https://www.bea.gov/news/schedule/full";
    const releaseDate = dateFromParts(local);
    entries.push(officialMarketScheduleEntrySchema.parse({
      source: "bea",
      eventKey: event.eventKey,
      name: event.name,
      sourceUid: `bea:${event.eventKey}:${releaseDate}:${timeText}:${title}`,
      sourceUrl,
      releaseDate,
      occurredAt: zonedDateTimeToIso(local, "America/New_York"),
      timezone: "America/New_York",
    }));
  }
  return uniqueSorted(entries);
}

export function parseFederalReserveSchedule(
  html: string,
  event: HighImpactEventDefinition,
) {
  const entries: OfficialMarketScheduleEntry[] = [];
  const sections = html.split(/<div class=["']panel panel-default["']>/i).slice(1);
  for (const section of sections) {
    const year = Number(section.match(/>(\d{4}) FOMC Meetings</i)?.[1]);
    if (!Number.isInteger(year)) continue;
    const meetingStarts = [...section.matchAll(
      /<div\b[^>]*class=["'][^"']*\brow\s+fomc-meeting\b[^"']*["'][^>]*>/gi,
    )];
    for (const [index, start] of meetingStarts.entries()) {
      const row = section.slice(
        start.index,
        meetingStarts[index + 1]?.index ?? section.length,
      );
      const month = cleanHtml(
        row.match(/fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>/i)?.[1] || "",
      );
      const dateRange = cleanHtml(
        row.match(/fomc-meeting__date[^>]*>([^<]+)<\/div>/i)?.[1] || "",
      );
      const days = dateRange.match(/\d{1,2}/g)?.map(Number) || [];
      const day = days.at(-1);
      const monthIndex = MONTHS.get(month.toLowerCase());
      if (!day || monthIndex === undefined) continue;
      const local = { year, month: monthIndex + 1, day, hour: 14, minute: 0, second: 0 };
      const releaseDate = dateFromParts(local);
      const statementPath = row.match(/href=["']([^"']*pressreleases\/monetary\d{8}a\.htm)["']/i)?.[1];
      entries.push(officialMarketScheduleEntrySchema.parse({
        source: "federal_reserve",
        eventKey: event.eventKey,
        name: event.name,
        sourceUid: `fomc-decision:${releaseDate}`,
        sourceUrl: statementPath
          ? new URL(statementPath, "https://www.federalreserve.gov").toString()
          : "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
        releaseDate,
        occurredAt: zonedDateTimeToIso(local, "America/New_York"),
        timezone: "America/New_York",
      }));
    }
  }
  return uniqueSorted(entries);
}

export function zonedDateTimeToIso(
  target: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
) {
  const targetEpoch = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  let guess = targetEpoch;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const representedEpoch = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour === 24 ? 0 : parts.hour,
      parts.minute,
      parts.second,
    );
    const delta = targetEpoch - representedEpoch;
    guess += delta;
    if (delta === 0) break;
  }
  return new Date(guess).toISOString();
}

async function fetchOfficialHtml(
  provider: string,
  url: string,
  signal?: AbortSignal,
) {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "text/html",
        "User-Agent": "AsaelPrivateResearch/1.0 (+https://asael.bennierichard.com)",
      },
      cache: "no-store",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new OfficialScheduleProviderError(
      provider,
      error instanceof Error && error.name === "TimeoutError"
        ? "the official release calendar timed out."
        : "the official release calendar could not be reached.",
    );
  }
  if (!response.ok) {
    throw new OfficialScheduleProviderError(
      provider,
      `the official release calendar returned HTTP ${response.status}.`,
    );
  }
  return response.text();
}

const MONTHS = new Map([
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
].map((month, index) => [month, index]));

function compactDateTime(value: string) {
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(4, 6)),
    day: Number(value.slice(6, 8)),
    hour: Number(value.slice(8, 10)),
    minute: Number(value.slice(10, 12)),
    second: 0,
  };
}

function parseNamedDateTime(year: number, dateText: string, timeText: string) {
  const date = dateText.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  const time = timeText.match(/^(\d{1,2}):(\d{2})\s+(AM|PM)$/i);
  const month = date ? MONTHS.get(date[1].toLowerCase()) : undefined;
  if (!date || !time || month === undefined) return null;
  const rawHour = Number(time[1]);
  return {
    year,
    month: month + 1,
    day: Number(date[2]),
    hour: rawHour % 12 + (time[3].toUpperCase() === "PM" ? 12 : 0),
    minute: Number(time[2]),
    second: 0,
  };
}

function dateFromParts(value: { year: number; month: number; day: number }) {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

function cleanHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueSorted(entries: OfficialMarketScheduleEntry[]) {
  return [...new Map(entries.map((entry) => [
    `${entry.source}:${entry.eventKey}:${entry.occurredAt}`,
    entry,
  ])).values()].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt) ||
    left.eventKey.localeCompare(right.eventKey)
  );
}
