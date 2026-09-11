import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("market forward-shadow migration", () => {
  it("installs immutable actor-private forecast, outcome, and event ledgers", async () => {
    const migration = await readFile(
      new URL(
        "../../../supabase/migrations/20260912003000_market_forward_shadow.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain("omni_market_forward_forecasts");
    expect(migration).toContain("omni_market_forecast_outcomes");
    expect(migration).toContain("omni_market_forecast_events");
    expect(migration).toContain("market.forward_forecast.sealed");
    expect(migration).toContain("market.forward_forecast.resolved");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("GRANT SELECT, INSERT");
    expect(migration).not.toContain("GRANT UPDATE");
    expect(migration).not.toContain("GRANT DELETE");
    expect(migration).toContain("'market_forward_shadow_v1'");
  });
});
