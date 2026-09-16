import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  showMarketLiveCalendarService: vi.fn(),
  createAppServiceCaller: vi.fn((input) => input),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorizeRequest,
}));
vi.mock("@/lib/app-services/contracts", () => ({
  createAppServiceCaller: mocks.createAppServiceCaller,
}));
vi.mock("@/lib/app-services/market-research", () => ({
  showMarketLiveCalendarService: mocks.showMarketLiveCalendarService,
}));

import { GET } from "@/app/api/market-research/calendar/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "actor-a",
    role: "admin",
    source: "session",
  });
});

describe("live market calendar route", () => {
  it("returns the private governed calendar projection", async () => {
    mocks.showMarketLiveCalendarService.mockResolvedValue({
      data: {
        contractVersion: "market-live-calendar:1",
        generatedAt: "2026-09-16T17:00:00.000Z",
        marketDate: "2026-09-16",
        timezone: "America/New_York",
        windowDays: 14,
        catalog: { reviewedFamilies: 17, exactTimeFamilies: 14, dateOnlyFamilies: 3, families: [] },
        events: [],
        sourceHealth: [],
        disclosures: [],
      },
      receipt: { operation: "app.market_research.events.list" },
    });

    const response = await GET(new Request(
      "http://localhost/api/market-research/calendar?days=14",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "market_event_history",
    }));
    expect(mocks.showMarketLiveCalendarService).toHaveBeenCalledWith(
      expect.anything(),
      { days: 14 },
    );
  });

  it("rejects a calendar window outside the bounded contract", async () => {
    const response = await GET(new Request(
      "http://localhost/api/market-research/calendar?days=90",
    ));

    expect(response.status).toBe(400);
    expect(mocks.showMarketLiveCalendarService).not.toHaveBeenCalled();
  });
});
