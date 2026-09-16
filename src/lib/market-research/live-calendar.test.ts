import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bls: vi.fn(),
  census: vi.fn(),
  bea: vi.fn(),
  federalReserve: vi.fn(),
}));

vi.mock("@/lib/market-research/bls", () => ({
  fetchBlsReleaseSchedule: mocks.bls,
}));
vi.mock("@/lib/market-research/official-schedules", () => ({
  fetchCensusReleaseSchedule: mocks.census,
  fetchBeaReleaseSchedule: mocks.bea,
  fetchFederalReserveReleaseSchedule: mocks.federalReserve,
}));

import { buildMarketLiveCalendar } from "@/lib/market-research/live-calendar";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bls.mockResolvedValue([]);
  mocks.census.mockResolvedValue([]);
  mocks.bea.mockResolvedValue([]);
  mocks.federalReserve.mockResolvedValue([]);
});

describe("live market calendar", () => {
  it("projects a same-day FOMC before its release from the official schedule", async () => {
    mocks.federalReserve.mockResolvedValue([{
      source: "federal_reserve",
      eventKey: "us.fomc",
      name: "Federal Open Market Committee Decision",
      sourceUid: "fomc-decision:2026-09-16",
      sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
      releaseDate: "2026-09-16",
      occurredAt: "2026-09-16T18:00:00.000Z",
      timezone: "America/New_York",
    }]);

    const result = await buildMarketLiveCalendar({
      days: 14,
      now: new Date("2026-09-16T17:00:00.000Z"),
    });

    expect(result.marketDate).toBe("2026-09-16");
    expect(result.catalog.reviewedFamilies).toBe(17);
    expect(result.events).toEqual([
      expect.objectContaining({
        eventKey: "us.fomc",
        dayState: "today",
        releaseState: "scheduled",
        components: expect.arrayContaining([
          "Rate decision",
          "Economic projections",
          "Press conference",
        ]),
      }),
    ]);
  });

  it("keeps healthy official sources usable when one calendar is unavailable", async () => {
    mocks.census.mockRejectedValue(new Error("offline"));

    const result = await buildMarketLiveCalendar({
      days: 7,
      now: new Date("2026-09-16T20:00:00.000Z"),
    });

    expect(result.sourceHealth.find(({ source }) => source === "census"))
      .toMatchObject({ status: "unavailable", eventCount: 0 });
    expect(result.sourceHealth.find(({ source }) => source === "bls"))
      .toMatchObject({ status: "connected" });
  });
});
