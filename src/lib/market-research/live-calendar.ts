import "server-only";

import {
  MARKET_LIVE_CALENDAR_VERSION,
  marketLiveCalendarResultSchema,
  type MarketLiveCalendarResult,
} from "@/lib/market-research/contracts";
import { highImpactEventCatalog } from "@/lib/market-research/event-catalog";
import {
  fetchBeaReleaseSchedule,
  fetchCensusReleaseSchedule,
  fetchFederalReserveReleaseSchedule,
  type OfficialMarketScheduleEntry,
} from "@/lib/market-research/official-schedules";
import { fetchBlsReleaseSchedule } from "@/lib/market-research/bls";

const MARKET_TIMEZONE = "America/New_York" as const;

const scheduleProviders = [
  { source: "bls" as const, fetch: fetchBlsReleaseSchedule },
  { source: "census" as const, fetch: fetchCensusReleaseSchedule },
  { source: "bea" as const, fetch: fetchBeaReleaseSchedule },
  { source: "federal_reserve" as const, fetch: fetchFederalReserveReleaseSchedule },
];

export async function buildMarketLiveCalendar(input: {
  days: number;
  now?: Date;
  signal?: AbortSignal;
}): Promise<MarketLiveCalendarResult> {
  const now = input.now || new Date();
  const marketDate = dateInTimeZone(now, MARKET_TIMEZONE);
  const endDate = addUtcDays(marketDate, input.days);
  const settled = await Promise.allSettled(scheduleProviders.map(({ fetch }) => fetch({
    events: highImpactEventCatalog,
    startDate: marketDate,
    endDate,
    signal: input.signal,
  })));
  const definitions = new Map(
    highImpactEventCatalog.map((definition) => [definition.eventKey, definition]),
  );
  const entries: OfficialMarketScheduleEntry[] = [];
  const sourceHealth = scheduleProviders.map(({ source }, index) => {
    const result = settled[index];
    if (result.status === "fulfilled") {
      entries.push(...result.value);
      return {
        source,
        status: "connected" as const,
        eventCount: result.value.length,
        note: result.value.length
          ? "Official schedule loaded for the selected window."
          : "Official schedule loaded; no reviewed release falls in this window.",
      };
    }
    return {
      source,
      status: "unavailable" as const,
      eventCount: 0,
      note: "This official schedule is temporarily unavailable; other sources remain usable.",
    };
  });
  const uniqueEntries = [...new Map(entries.map((entry) => [
    `${entry.source}:${entry.eventKey}:${entry.occurredAt}`,
    entry,
  ])).values()].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt) ||
    left.eventKey.localeCompare(right.eventKey)
  );

  return marketLiveCalendarResultSchema.parse({
    contractVersion: MARKET_LIVE_CALENDAR_VERSION,
    generatedAt: now.toISOString(),
    marketDate,
    timezone: MARKET_TIMEZONE,
    windowDays: input.days,
    catalog: {
      reviewedFamilies: highImpactEventCatalog.length,
      exactTimeFamilies: highImpactEventCatalog.filter(
        ({ scheduleCoverage }) => scheduleCoverage === "official_exact",
      ).length,
      dateOnlyFamilies: highImpactEventCatalog.filter(
        ({ scheduleCoverage }) => scheduleCoverage === "date_only_until_verified",
      ).length,
      families: highImpactEventCatalog.map((definition) => ({
        eventKey: definition.eventKey,
        name: definition.name,
        category: definition.category,
        components: definition.components,
        aliases: definition.aliases,
        scheduleCoverage: definition.scheduleCoverage,
        whyItMatters: definition.whyItMatters,
        sourceUrl: definition.sourceUrl,
      })),
    },
    events: uniqueEntries.map((entry) => {
      const definition = definitions.get(entry.eventKey);
      if (!definition) {
        throw new Error(`Unreviewed live market event: ${entry.eventKey}`);
      }
      return {
        source: entry.source,
        eventKey: entry.eventKey,
        name: entry.name,
        category: definition.category,
        components: definition.components,
        whyItMatters: definition.whyItMatters,
        sourceUrl: entry.sourceUrl,
        releaseDate: entry.releaseDate,
        occurredAt: entry.occurredAt,
        timezone: entry.timezone,
        dayState: entry.releaseDate === marketDate ? "today" : "upcoming",
        releaseState: entry.occurredAt <= now.toISOString() ? "released" : "scheduled",
      };
    }),
    sourceHealth,
    disclosures: [
      "Coverage is a reviewed set of high-impact U.S. releases from official public calendars, not a claim to mirror every event on a commercial red-folder calendar.",
      "Official free sources do not provide a complete historical survey-consensus archive. Asael leaves unavailable consensus and surprise fields empty.",
      "Date-only families remain visible in coverage but are excluded from intraday replay until an authoritative release time is verified.",
      "Historical reactions are descriptive evidence, not calibrated probabilities or trading advice.",
    ],
  });
}

function dateInTimeZone(value: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addUtcDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
