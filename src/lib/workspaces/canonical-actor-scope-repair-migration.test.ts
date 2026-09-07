import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260908001500_p10_5_canonical_actor_scope_repair.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("P10.5 canonical actor scope repair migration", () => {
  it("matches both canonical and registered legacy actor identifiers", () => {
    expect(migration).toContain("omni_current_actor_scope_v1()");
    expect(migration).toContain(
      "identifier.actor_identifier = scoped.actor_identifier",
    );
    expect(migration).toContain(
      "identifier.canonical_actor_id = scoped.actor_identifier",
    );
    expect(migration).toContain(
      "identifier.canonical_actor_id = candidate_canonical_actor_id",
    );
  });

  it("keeps the helper private and grants only the runtime call boundary", () => {
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
    expect(migration).toContain("TO omni_runtime");
    expect(migration).not.toContain("GRANT SELECT ON omni_auth_user_actor_identifiers");
  });

  it("records ordered migration 133", () => {
    expect(migration).toContain("version = 132");
    expect(migration).toContain("133,");
    expect(migration).toContain("canonical_actor_scope_repair_v1");
  });
});
