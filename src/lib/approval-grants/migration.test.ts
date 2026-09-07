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
    const databaseClient = await readFile(
      new URL("../db/client.ts", import.meta.url),
      "utf8",
    );
    const embeddedMigration = databaseClient.slice(
      databaseClient.indexOf("async function ensureApprovalGrantsV1"),
      databaseClient.indexOf("async function ensureGraphQueryTelemetryV1"),
    );

    for (const source of [migration, embeddedMigration]) {
      expect(source).toContain("omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
      expect(source).toContain("Approval grant claims are append-only");
      expect(source).toContain("Approval grant audit records cannot be removed");
      expect(source).toContain(
        "state, used_uses, lifecycle_revision, grant_payload, last_used_at, revoked_at",
      );
      expect(source).toContain("grant_payload JSONB NOT NULL");
      expect(source).not.toContain("grant JSONB NOT NULL");
      expect(source).not.toMatch(
        /FOREIGN KEY \(owner_actor_id\)\s+REFERENCES omni_auth_users \(actor_id\)/,
      );
      expect(source).not.toMatch(
        /GRANT (?:UPDATE|DELETE|TRUNCATE) ON omni_approval_grant_claims/,
      );
    }
  });
});
