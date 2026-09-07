import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("P11.1 cohesive Today migration", () => {
  it("pins actor-owned section visibility after the complete customer-success schema", async () => {
    const sql = await readFile(
      path.join(process.cwd(), "supabase/migrations/20260908070000_p11_1_cohesive_today.sql"),
      "utf8",
    );
    expect(sql).toContain("version = 141");
    expect(sql).toContain("ADD COLUMN visible_sections TEXT[] NOT NULL");
    expect(sql).toContain("omni_today_preferences_visible_sections_valid");
    expect(sql).toContain("cardinality(visible_sections) BETWEEN 1 AND 9");
    expect(sql).toContain("'cohesive_today_preferences_v1'");
    expect(sql).toContain("c2ccb45d121194793876b68fec90c68f2d1bdfadcc889aebdd5abd9f4bd8763d");
  });
});
