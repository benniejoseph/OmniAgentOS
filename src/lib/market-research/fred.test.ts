import { afterEach, describe, expect, it, vi } from "vitest";

import { highImpactEventCatalog } from "@/lib/market-research/event-catalog";
import { fetchFredReleaseDates } from "@/lib/market-research/fred";

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
});
