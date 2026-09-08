import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260908170000_delegation_actor_identifier_compatibility.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("delegation actor identifier compatibility migration", () => {
  it("accepts only registered canonical or legacy auth-user actor identifiers", () => {
    expect(migration).toContain("version = 148");
    expect(migration).toContain("omni_delegation_tasks_owner_actor_id_fkey");
    expect(migration).toContain(
      "omni_delegation_tasks_owner_actor_identifier_fkey",
    );
    expect(migration).toContain(
      "REFERENCES omni_auth_user_actor_identifiers (actor_identifier)",
    );
    expect(migration).toContain(
      "A delegation task owner is not a registered auth-user actor identifier",
    );
  });

  it("records ordered migration 149", () => {
    expect(migration).toContain("149,");
    expect(migration).toContain(
      "delegation_actor_identifier_compatibility_v1",
    );
    expect(migration).toContain(
      "e23652ba4ff4fb4598d3671175e36d8a4a2974af839031477033d9924bc03810",
    );
  });
});
