import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260908023000_p10_11_salesforce_guarded_writes.sql",
  "utf8",
);

describe("Salesforce guarded-write migration", () => {
  it("installs the account activation and immutable operation boundaries", () => {
    expect(migration).toContain("CREATE TABLE omni_salesforce_write_operations");
    expect(migration).toContain("'disabled', 'approval_required'");
    expect(migration).toContain("omni_salesforce_write_operations_protected");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("omni_salesforce_write_operations_update_scope");
    expect(migration).toContain("provider_idempotency_key_sha256");
    expect(migration).toContain("commit_snapshot JSONB");
    expect(migration).not.toMatch(/GRANT\s+DELETE/i);
  });

  it("pins schema version 139 to the exact read-sync predecessor", () => {
    expect(migration).toContain("version = 138");
    expect(migration).toContain("'salesforce_read_sync_v1'");
    expect(migration).toContain("'salesforce_guarded_writes_v1'");
    expect(migration).toContain("1abb9529ce56ff31484da98bc52de725d7c6402792dbff1b0b1706abc7c9f1e1");
  });
});
