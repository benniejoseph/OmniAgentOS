import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260907234500_p10_4_canonical_workspace_resolver_repair.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("P10.4 canonical Workspace resolver repair migration", () => {
  it("uses unambiguous constraint-qualified conflict targets", () => {
    expect(migration).toContain(
      "ON CONFLICT ON CONSTRAINT omni_tenant_workspaces_pkey DO NOTHING",
    );
    expect(migration).toContain(
      "ON CONFLICT ON CONSTRAINT omni_workspace_memberships_pkey DO NOTHING",
    );
    expect(migration).not.toContain("ON CONFLICT (tenant_id, workspace_id)");
  });

  it("preserves the scoped security-definer boundary", () => {
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("omni_actor_scope_v1_allows(");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
    expect(migration).toContain("TO omni_runtime");
  });

  it("records ordered migration 131", () => {
    expect(migration).toContain("version = 130");
    expect(migration).toContain("131,");
    expect(migration).toContain("canonical_workspace_resolver_repair_v1");
  });
});
