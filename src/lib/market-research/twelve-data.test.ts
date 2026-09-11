import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchTwelveDataBarRangeSnapshot,
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

  it("rejects an oversized provider response before parsing it", async () => {
    process.env.TWELVE_DATA_API_KEY = "test-market-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ padding: "x".repeat(2_000_001) }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    await expect(fetchTwelveDataBars({
      instrumentId: "xauusd.spot",
      interval: "15min",
      outputSize: 100,
    })).rejects.toThrow(/oversized response/i);
  });

  it("requests an exact UTC range without applying an output-size cap", async () => {
    process.env.TWELVE_DATA_API_KEY = "test-market-key";
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      meta: { symbol: "XAU/USD", timezone: "UTC" },
      values: [
        { datetime: "2026-09-10 13:00:00", open: "4000", high: "4002", low: "3998", close: "4001", volume: null },
        { datetime: "2026-09-10 12:55:00", open: "3999", high: "4001", low: "3997", close: "4000", volume: null },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchTwelveDataBarRangeSnapshot({
      instrumentId: "xauusd.spot",
      interval: "5min",
      startAt: "2026-09-10T12:00:00.000Z",
      endAt: "2026-09-10T14:00:00.000Z",
    });

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get("start_date")).toBe("2026-09-10 12:00:00");
    expect(url.searchParams.get("end_date")).toBe("2026-09-10 14:00:00");
    expect(url.searchParams.has("outputsize")).toBe(false);
    expect(snapshot.result.bars.map((bar) => bar.close)).toEqual([4000, 4001]);
  });

  it("rejects oversized or reversed historical ranges before provider access", async () => {
    process.env.TWELVE_DATA_API_KEY = "test-market-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTwelveDataBarRangeSnapshot({
      instrumentId: "xauusd.spot",
      interval: "5min",
      startAt: "2026-09-01T00:00:00.000Z",
      endAt: "2026-09-10T00:00:00.000Z",
    })).rejects.toThrow(/no longer than 72 hours/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects provider bars outside the exact historical request", async () => {
    process.env.TWELVE_DATA_API_KEY = "test-market-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      meta: { symbol: "XAU/USD", timezone: "UTC" },
      values: [
        { datetime: "2026-09-10 15:00:00", open: "4000", high: "4002", low: "3998", close: "4001", volume: null },
      ],
    })));

    await expect(fetchTwelveDataBarRangeSnapshot({
      instrumentId: "xauusd.spot",
      interval: "5min",
      startAt: "2026-09-10T12:00:00.000Z",
      endAt: "2026-09-10T14:00:00.000Z",
    })).rejects.toThrow(/outside the requested historical range/i);
  });
});
