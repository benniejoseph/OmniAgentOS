import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("P9.4 approval grant migration", () => {
  it("installs actor-private grants, append-only claims, and lifecycle-only updates", async () => {
    const migration = await readFile(
      new URL(
        "../../../supabase/migrations/20260907094000_p9_4_approval_grants.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain("omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
    expect(migration).toContain("Approval grant claims are append-only");
    expect(migration).toContain("Approval grant audit records cannot be removed");
    expect(migration).toContain(
      "state, used_uses, lifecycle_revision, grant_payload, last_used_at, revoked_at",
    );
    expect(migration).toContain("grant_payload JSONB NOT NULL");
    expect(migration).not.toContain("grant JSONB NOT NULL");
    expect(migration).not.toMatch(
      /FOREIGN KEY \(owner_actor_id\)\s+REFERENCES omni_auth_users \(actor_id\)/,
    );
    expect(migration).not.toMatch(
      /GRANT (?:UPDATE|DELETE|TRUNCATE) ON omni_approval_grant_claims/,
    );
  });
});
