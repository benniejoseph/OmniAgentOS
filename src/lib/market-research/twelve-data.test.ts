import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchTwelveDataBars,
  MarketDataCredentialRequiredError,
} from "@/lib/market-research/twelve-data";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TWELVE_DATA_API_KEY;
});

describe("Twelve Data market adapter", () => {
  it("keeps the credential out of the URL and normalizes oldest-first bars", async () => {
    process.env.TWELVE_DATA_API_KEY = "test-market-key";
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      meta: { symbol: "XAU/USD", timezone: "UTC" },
      values: [
        { datetime: "2026-09-10 10:15:00", open: "4001", high: "4004", low: "3999", close: "4003", volume: null },
        { datetime: "2026-09-10 10:00:00", open: "4000", high: "4002", low: "3998", close: "4001", volume: "12" },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTwelveDataBars({
      instrumentId: "xauusd.spot",
      interval: "15min",
      outputSize: 100,
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).not.toContain("test-market-key");
    expect(init.headers).toEqual({ Authorization: "apikey test-market-key" });
    expect(result).toMatchObject({
      provider: "twelve_data",
      providerSymbol: "XAU/USD",
      interval: "15min",
      asOf: "2026-09-10T10:15:00.000Z",
    });
    expect(result.bars.map((bar) => bar.close)).toEqual([4001, 4003]);
  });

  it("fails closed without a credential", async () => {
    await expect(fetchTwelveDataBars({
      instrumentId: "xauusd.spot",
      interval: "15min",
      outputSize: 100,
    })).rejects.toBeInstanceOf(MarketDataCredentialRequiredError);

  });

  it("uses the explicit NDX mapping and explains plan entitlement failures", async () => {
    process.env.TWELVE_DATA_API_KEY = "test-market-key";
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      status: "error",
      code: 404,
      message: "This symbol is available starting with the Grow or Venture plan. Consider upgrading now.",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTwelveDataBars({
      instrumentId: "ndx.cash",
      interval: "15min",
      outputSize: 100,
    })).rejects.toThrow(/recognizes NDX.*time-series entitlement/i);

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get("symbol")).toBe("NDX");
  });
});
