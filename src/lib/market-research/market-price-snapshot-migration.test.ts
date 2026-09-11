import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("market price snapshot migration", () => {
  it("creates immutable actor-scoped snapshot and observation ledgers", async () => {
    const migration = await readFile(
      new URL(
        "../../../supabase/migrations/20260911220000_market_price_snapshots.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain("omni_market_price_snapshots");
    expect(migration).toContain("omni_market_price_snapshot_events");
    expect(migration).toContain("market.price_snapshot.observed");
    expect(migration).toContain("source_payload JSONB");
    expect(migration).toContain("normalized_bars JSONB");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("omni_actor_scope_v1_allows");
    expect(migration).toContain("GRANT SELECT, INSERT");
    expect(migration).not.toMatch(/GRANT[^;]+UPDATE/i);
    expect(migration).not.toMatch(/GRANT[^;]+DELETE/i);
    expect(migration).toContain("'market_price_snapshot_v1'");
  });
});
