import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("market event schedule migration", () => {
  it("creates immutable actor-scoped BLS schedule and event ledgers", async () => {
    const migration = await readFile(
      new URL(
        "../../../supabase/migrations/20260911210000_market_event_schedule.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain("omni_market_macro_event_schedules");
    expect(migration).toContain("omni_market_macro_event_schedule_events");
    expect(migration).toContain("market.macro_event.schedule_observed");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("omni_actor_scope_v1_allows");
    expect(migration).toContain("GRANT SELECT, INSERT");
    expect(migration).not.toMatch(/GRANT[^;]+UPDATE/i);
    expect(migration).not.toMatch(/GRANT[^;]+DELETE/i);
    expect(migration).toContain("'market_event_schedule_v1'");
  });
});
