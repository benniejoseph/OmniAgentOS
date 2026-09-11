import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260912010000_market_forward_shadow_clock_skew.sql",
);

describe("market forward-shadow clock-skew migration", () => {
  it("keeps the seal immutable while bounding cross-system clock skew", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain("latest_version IS DISTINCT FROM 164");
    expect(sql).toContain("sealed_at < window_start");
    expect(sql).toContain(
      "sealed_at <= created_at + INTERVAL '30 seconds'",
    );
    expect(sql).toContain("AND created_at <= NOW()");
    expect(sql).toContain("pg_get_constraintdef(oid) LIKE '%00:00:30%'");
    expect(sql).toContain("'market_forward_shadow_clock_skew_v1'");
  });
});
