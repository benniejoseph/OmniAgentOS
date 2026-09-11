import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchBlsReleaseSchedule,
  parseBlsCalendar,
} from "@/lib/market-research/bls";
import { highImpactEventCatalog } from "@/lib/market-research/event-catalog";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BLS official calendar adapter", () => {
  it("maps reviewed releases and converts Eastern time across DST", () => {
    const calendar = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:winter-cpi",
      "DTSTART;TZID=US-Eastern:20250115T083000",
      "SUMMARY:Consumer Price Index",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:summer-jolts",
      "DTSTART;TZID=US-Eastern:20250701T100000",
      "SUMMARY:Job Openings and Labor Turnover Survey",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ignored",
      "DTSTART;TZID=US-Eastern:20250702T100000",
      "SUMMARY:Unreviewed Release",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    expect(parseBlsCalendar(calendar, highImpactEventCatalog)).toEqual([
      expect.objectContaining({
        eventKey: "us.cpi",
        releaseDate: "2025-01-15",
        occurredAt: "2025-01-15T13:30:00.000Z",
      }),
      expect.objectContaining({
        eventKey: "us.jolts",
        releaseDate: "2025-07-01",
        occurredAt: "2025-07-01T14:00:00.000Z",
      }),
    ]);
  });

  it("identifies Asael to BLS and filters the official calendar by date", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:included-cpi",
      "DTSTART;TZID=US-Eastern:20250115T083000",
      "SUMMARY:Consumer Price Index",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:excluded-cpi",
      "DTSTART;TZID=US-Eastern:20250212T083000",
      "SUMMARY:Consumer Price Index",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"), {
      status: 200,
      headers: { "Content-Type": "text/calendar" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const entries = await fetchBlsReleaseSchedule({
      events: highImpactEventCatalog,
      startDate: "2025-01-01",
      endDate: "2025-01-31",
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      eventKey: "us.cpi",
      releaseDate: "2025-01-15",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.bls.gov/schedule/news_release/bls.ics",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Accept: "text/calendar",
          "User-Agent": expect.stringContaining("AsaelPrivateResearch"),
        }),
      }),
    );
  });
});
