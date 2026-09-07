import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260908030000_p10_12_customer_health_scoring.sql",
  "utf8",
);

describe("customer health scoring migration", () => {
  it("installs immutable policy and score history plus a monotonic projection", () => {
    expect(migration).toContain("CREATE TABLE omni_customer_health_policies");
    expect(migration).toContain("CREATE TABLE omni_customer_health_score_revisions");
    expect(migration).toContain("CREATE TABLE omni_customer_health_scores");
    expect(migration).toContain("omni_customer_health_score_revisions_immutable");
    expect(migration).toContain("omni_protect_customer_health_projection_v1");
    expect(migration).toContain("NEW.current_revision <> OLD.current_revision + 1");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("omni_customer_health_scores_update_scope");
    expect(migration).not.toMatch(/GRANT\s+DELETE/i);
  });

  it("pins schema version 140 to the exact guarded-write predecessor", () => {
    expect(migration).toContain("version = 139");
    expect(migration).toContain("'salesforce_guarded_writes_v1'");
    expect(migration).toContain("'customer_health_scoring_v1'");
    expect(migration).toContain(
      "91f12ad0fdae25496f14bf21751491470f4572bcb58c587360373dc038b063e2",
    );
  });
});
