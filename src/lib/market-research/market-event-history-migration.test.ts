import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("market event history migration", () => {
  it("creates immutable actor-scoped release and event ledgers", async () => {
    const migration = await readFile(
      new URL(
        "../../../supabase/migrations/20260911190000_market_event_history.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain("omni_market_macro_events");
    expect(migration).toContain("omni_market_macro_event_events");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("omni_actor_scope_v1_allows");
    expect(migration).toContain("GRANT SELECT, INSERT");
    expect(migration).not.toMatch(/GRANT[^;]+UPDATE/i);
    expect(migration).not.toMatch(/GRANT[^;]+DELETE/i);
    expect(migration).toContain("'market_event_history_v1'");
  });
});
