import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("P11.9 source coverage migration", () => {
  it("installs strict granular source checkpoints without exposing cursor values", async () => {
    const sql = await readFile(
      new URL("../../../supabase/migrations/20260908090000_p11_9_source_coverage_projection.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS source_sync_health JSONB");
    expect(sql).toContain("omni_oauth_source_sync_health_v1_is_valid");
    expect(sql).toContain("'mail', 'calendar', 'drive'");
    expect(sql).toContain("'unknown', 'in_progress', 'complete'");
    expect(sql).not.toContain("request_cursor");
    expect(sql).not.toContain("sealed_tokens");
    expect(sql).toContain("source_coverage_projection_v1");
  });
});
