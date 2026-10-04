import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sql: vi.fn(), available: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ getSql: () => mocks.sql, hasDatabaseUrl: () => mocks.available, ensureDatabaseSchema: vi.fn() }));
import { listStoredMarketPriceSnapshots } from "./price-snapshot-store";
import { listMarketAnalysisMetadata } from "./analysis-store";
const request = { tenantId: "tenant-a", actorId: "actor-a", instrumentId: "xauusd.spot", interval: "15min" as const, limit: 1 };
describe("bounded stored Market projections", () => {
  beforeEach(() => { mocks.available = true; mocks.sql.mockReset(); });
  it("reports unavailable storage instead of a complete empty page", async () => {
    mocks.available = false;
    await expect(listStoredMarketPriceSnapshots(request)).rejects.toThrow(/database/i);
    await expect(listMarketAnalysisMetadata(request)).rejects.toThrow();
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it("uses an owner-filtered sentinel without selecting provider payload or bars", async () => {
    const row = { id: `market_snapshot_${"a".repeat(48)}`, normalized_sha256: "b".repeat(64), instrument_id: "xauusd.spot", provider: "twelve_data", provider_symbol: "XAU/USD", provider_timezone: "UTC", interval: "15min", retrieved_at: "2026-10-04T10:00:00.000Z", as_of: "2026-10-04T09:00:00.000Z", bar_count: 3 };
    mocks.sql.mockResolvedValue([row, { ...row, id: `market_snapshot_${"c".repeat(48)}` }]);
    const result = await listStoredMarketPriceSnapshots(request);
    expect(result.snapshots).toHaveLength(1); expect(result.hasMore).toBe(true);
    const [strings, ...values] = mocks.sql.mock.calls[0];
    expect(strings.join("?")).toContain("jsonb_array_length(normalized_bars)");
    expect(strings.join("?")).toContain("owner_actor_id =");
    expect(strings.join("?")).not.toContain("source_payload");
    expect(values).toContain("tenant-a"); expect(values).toContain("actor-a"); expect(values.at(-1)).toBe(2);
  });
  it("removes arbitrary chart state inside SQL and preserves the bounded total", async () => {
    mocks.sql.mockResolvedValue([]);
    expect(await listMarketAnalysisMetadata(request)).toMatchObject({ view: "metadata", versions: [], total: 0 });
    expect(mocks.sql.mock.calls[0][0].join("?")).toContain("analysis_version - 'chartState'");
    await expect(listMarketAnalysisMetadata({ ...request, limit: 41 })).rejects.toThrow();
  });
});
