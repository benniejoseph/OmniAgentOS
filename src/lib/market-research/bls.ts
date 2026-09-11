import "server-only";

import { z } from "zod";

import type { HighImpactEventDefinition } from "@/lib/market-research/event-catalog";

const calendarEntrySchema = z.object({
  eventKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  name: z.string().min(1).max(160),
  sourceUid: z.string().min(1).max(300),
  sourceUrl: z.string().url(),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  occurredAt: z.string().datetime({ offset: true }),
  timezone: z.literal("America/New_York"),
}).strict();

export type BlsReleaseScheduleEntry = z.infer<typeof calendarEntrySchema>;

export class BlsProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlsProviderError";
  }
}

export async function fetchBlsReleaseSchedule(input: {
  events: readonly HighImpactEventDefinition[];
  startDate: string;
  endDate: string;
  signal?: AbortSignal;
}): Promise<BlsReleaseScheduleEntry[]> {
  let response: Response;
  try {
    response = await fetch("https://www.bls.gov/schedule/news_release/bls.ics", {
      headers: {
        Accept: "text/calendar",
        "User-Agent": "AsaelPrivateResearch/1.0 (+https://asael.bennierichard.com)",
      },
      cache: "no-store",
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new BlsProviderError(
      error instanceof Error && error.name === "TimeoutError"
        ? "BLS did not respond before the release-calendar timeout."
        : "The official BLS release calendar could not be reached.",
    );
  }
  if (!response.ok) {
    throw new BlsProviderError(
      response.status === 429
        ? "BLS rate limited the release-calendar request."
        : `BLS returned HTTP ${response.status} for its official release calendar.`,
    );
  }
  const calendar = await response.text();
  return parseBlsCalendar(calendar, input.events).filter((entry) =>
    entry.releaseDate >= input.startDate && entry.releaseDate <= input.endDate
  );
}

export function parseBlsCalendar(
  calendar: string,
  events: readonly HighImpactEventDefinition[],
) {
  const definitions = new Map(
    events.flatMap((event) => event.blsSchedule
      ? [[normalizeSummary(event.blsSchedule.summary), event] as const]
      : []),
  );
  const unfolded = calendar.replace(/\r?\n[ \t]/g, "");
  const entries: BlsReleaseScheduleEntry[] = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT", 1)[0] || "";
    const summary = calendarProperty(body, "SUMMARY");
    const sourceUid = calendarProperty(body, "UID");
    const start = body.match(/^DTSTART(?:;TZID=([^:\r\n]+))?:(\d{8}T\d{6})(Z)?$/m);
    if (!summary || !sourceUid || !start) continue;
    const definition = definitions.get(normalizeSummary(summary));
    if (!definition?.blsSchedule) continue;
    const timezone = start[1];
    if (timezone && !["US-Eastern", "America/New_York"].includes(timezone)) {
      continue;
    }
    const local = parseCalendarDateTime(start[2]);
    const occurredAt = start[3]
      ? new Date(Date.UTC(
          local.year,
          local.month - 1,
          local.day,
          local.hour,
          local.minute,
          local.second,
        )).toISOString()
      : zonedDateTimeToIso(local, "America/New_York");
    entries.push(calendarEntrySchema.parse({
      eventKey: definition.eventKey,
      name: definition.name,
      sourceUid,
      sourceUrl: definition.blsSchedule.sourceUrl,
      releaseDate: `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`,
      occurredAt,
      timezone: "America/New_York",
    }));
  }
  return entries.sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt) ||
    left.eventKey.localeCompare(right.eventKey)
  );
}

function calendarProperty(block: string, name: string) {
  const match = block.match(new RegExp(`^${name}:([^\\r\\n]+)$`, "m"));
  return match?.[1]
    ?.replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function normalizeSummary(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseCalendarDateTime(value: string) {
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(4, 6)),
    day: Number(value.slice(6, 8)),
    hour: Number(value.slice(9, 11)),
    minute: Number(value.slice(11, 13)),
    second: Number(value.slice(13, 15)),
  };
}

function zonedDateTimeToIso(
  target: ReturnType<typeof parseCalendarDateTime>,
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
