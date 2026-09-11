import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("official market schedule sources migration", () => {
  it("admits only reviewed first-party calendar domains", async () => {
    const migration = await readFile(
      new URL(
        "../../../supabase/migrations/20260911230000_market_official_schedule_sources.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain("source IN ('bls', 'census', 'bea', 'federal_reserve')");
    expect(migration).toContain("https://www.bls.gov/%");
    expect(migration).toContain("https://www.census.gov/%");
    expect(migration).toContain("https://www.bea.gov/%");
    expect(migration).toContain("https://www.federalreserve.gov/%");
    expect(migration).toContain("'market_official_schedule_sources_v1'");
  });
});
