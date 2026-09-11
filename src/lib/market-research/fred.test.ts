import { afterEach, describe, expect, it, vi } from "vitest";

import { highImpactEventCatalog } from "@/lib/market-research/event-catalog";
import {
  fetchFredInitialObservations,
  fetchFredReleaseDates,
} from "@/lib/market-research/fred";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FRED_API_KEY;
});

describe("FRED high-impact release history", () => {
  it("filters official release dates to the requested historical range", async () => {
    process.env.FRED_API_KEY = "test-fred-key";
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      release_dates: [
        { release_id: 10, date: "1999-12-01" },
        { release_id: 10, date: "2000-01-14" },
        { release_id: 10, date: "2000-02-18" },
        { release_id: 10, date: "2001-01-01" },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchFredReleaseDates({
      event: highImpactEventCatalog.find(({ eventKey }) => eventKey === "us.cpi")!,
      startDate: "2000-01-01",
      endDate: "2000-12-31",
    });

    expect(result.map(({ releaseDate }) => releaseDate)).toEqual([
      "2000-01-14",
      "2000-02-18",
    ]);
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get("release_id")).toBe("10");
    expect(url.searchParams.get("api_key")).toBe("test-fred-key");
  });

  it("requests initial-release-only levels and binds them to their vintage date", async () => {
    process.env.FRED_API_KEY = "test-fred-key";
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      observations: [
        {
          realtime_start: "1999-12-15",
          realtime_end: "1999-12-31",
          date: "1999-11-01",
          value: "168.3",
        },
        {
          realtime_start: "2000-01-14",
          realtime_end: "9999-12-31",
          date: "1999-12-01",
          value: "168.8",
        },
        {
          realtime_start: "2000-02-18",
          realtime_end: "9999-12-31",
          date: "2000-01-01",
          value: ".",
        },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const cpi = highImpactEventCatalog.find(({ eventKey }) =>
      eventKey === "us.cpi"
    )!;

    const result = await fetchFredInitialObservations({
      event: cpi,
      series: cpi.fredSeries[0],
      startDate: "2000-01-01",
      endDate: "2000-12-31",
    });

    expect(result).toEqual([
      expect.objectContaining({
        eventKey: "us.cpi",
        seriesId: "CPIAUCSL",
        observationDate: "1999-12-01",
        releaseDate: "2000-01-14",
        value: 168.8,
      }),
    ]);
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get("output_type")).toBe("4");
    expect(url.searchParams.get("units")).toBe("lin");
    expect(url.searchParams.get("realtime_start")).toBe("1776-07-04");
    expect(url.searchParams.get("realtime_end")).toBe("9999-12-31");
  });
});
