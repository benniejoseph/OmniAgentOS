import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260909093000_google_workspace_projection_queue_repair.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Google Workspace projection queue repair migration", () => {
  it("adds the permissive actor policy required by the restrictive queue policies", () => {
    expect(migration).toContain("version = 149");
    expect(migration).toContain(
      "CREATE POLICY omni_entity_relation_projection_queue_actor",
    );
    expect(migration).toContain("AS PERMISSIVE FOR ALL");
    expect(migration).toContain(
      "omni_actor_scope_v1_allows(tenant_id, owner_actor_id)",
    );
    expect(migration).toContain("AND NOT polpermissive");
  });

  it("records ordered migration 150", () => {
    expect(migration).toContain("150,");
    expect(migration).toContain(
      "entity_relation_projection_queue_actor_policy_repair_v1",
    );
    expect(migration).toContain(
      "0635323de69b0bd7b2c1c520dd27f7271a4833abd6ce7263e120bb1d69984122",
    );
  });
});
