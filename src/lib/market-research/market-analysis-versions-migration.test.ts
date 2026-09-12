import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("market analysis versions migration", () => {
  it("installs append-only actor-private analysis and drawing receipts", async () => {
    const migration = await readFile(path.join(
      process.cwd(),
      "supabase/migrations/20260912113000_market_analysis_versions.sql",
    ), "utf8");

    expect(migration).toContain("latest_version IS DISTINCT FROM 165");
    expect(migration).toContain("CREATE TABLE public.omni_market_analysis_versions");
    expect(migration).toContain("CREATE TABLE public.omni_market_analysis_events");
    expect(migration).toContain("market.analysis_version.saved");
    expect(migration).toContain("omni_market_price_snapshots_actor_key");
    expect(migration).toContain("tenant_id, snapshot_id, owner_actor_id");
    expect(migration).toContain("tenant_id, analysis_version_id, owner_actor_id");
    expect(migration).toContain("INTERVAL '30 seconds'");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("GRANT SELECT, INSERT");
    expect(migration).not.toContain("GRANT UPDATE");
    expect(migration).not.toContain("GRANT DELETE");
    expect(migration).toContain("market_analysis_versions_v1");
  });
});
