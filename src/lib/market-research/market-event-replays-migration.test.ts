import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("market event replay migration", () => {
  it("installs immutable actor-private replay snapshots and typed events", async () => {
    const migration = await readFile(
      new URL(
        "../../../supabase/migrations/20260911234500_market_event_replays.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain("omni_market_event_replays");
    expect(migration).toContain("omni_market_event_replay_events");
    expect(migration).toContain("market.event_replay.observed");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("GRANT SELECT, INSERT");
    expect(migration).not.toContain("GRANT UPDATE");
    expect(migration).not.toContain("GRANT DELETE");
    expect(migration).toContain("'market_event_replays_v1'");
  });
});
