import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("market macro observations migration", () => {
  it("creates immutable actor-scoped initial-release observations", async () => {
    const migration = await readFile(
      new URL(
        "../../../supabase/migrations/20260911233000_market_macro_observations.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain("omni_market_macro_observations");
    expect(migration).toContain("omni_market_macro_observation_events");
    expect(migration).toContain("market.macro_observation.initial_release_observed");
    expect(migration).toContain("initial_release");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("GRANT SELECT, INSERT");
    expect(migration).not.toMatch(/GRANT[^;]+UPDATE/i);
    expect(migration).not.toMatch(/GRANT[^;]+DELETE/i);
    expect(migration).toContain("'market_macro_observations_v1'");
  });
});
