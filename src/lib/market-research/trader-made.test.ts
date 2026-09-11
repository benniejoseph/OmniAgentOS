import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTraderMadeBars } from "@/lib/market-research/trader-made";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TRADERMADE_REST_API_KEY;
});

describe("TraderMade market adapter", () => {
  it("normalizes the explicit NAS100 CFD mapping", async () => {
    process.env.TRADERMADE_REST_API_KEY = "test-rest-key";
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      quotes: [
        { date: "2026-09-10 10:15:00", open: 25010, high: 25030, low: 24990, close: 25020 },
        { date: "2026-09-10 10:00:00", open: 25000, high: 25020, low: 24980, close: 25010 },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTraderMadeBars({
      instrumentId: "nas100.tradermade_cfd",
      interval: "15min",
      outputSize: 100,
    });

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get("currency")).toBe("NAS100");
    expect(url.searchParams.get("api_key")).toBe("test-rest-key");
    expect(result).toMatchObject({
      provider: "trader_made",
      providerSymbol: "NAS100",
      asOf: "2026-09-10T10:15:00.000Z",
    });
    expect(result.bars.map((bar) => bar.close)).toEqual([25010, 25020]);
  });

  it("reports a plan entitlement rejection", async () => {
    process.env.TRADERMADE_REST_API_KEY = "test-rest-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      error: "dataset_not_in_plan",
    })));

    await expect(fetchTraderMadeBars({
      instrumentId: "nas100.tradermade_cfd",
      interval: "15min",
      outputSize: 100,
    })).rejects.toThrow(/not included.*REST data plan/i);
  });
});
