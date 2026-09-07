import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260908020000_p10_10_salesforce_read_sync.sql",
), "utf8");

describe("Salesforce read-sync migration", () => {
  it("installs the connection, immutable revision, head and reconciliation ledgers", () => {
    for (const table of [
      "omni_salesforce_connections",
      "omni_salesforce_account_links",
      "omni_salesforce_record_revisions",
      "omni_salesforce_record_heads",
      "omni_salesforce_webhook_events",
      "omni_salesforce_reconciliation_findings",
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(migration).toContain("Salesforce synchronization evidence is immutable");
    expect(migration).toContain("UNIQUE (organization_id_sha256, salesforce_account_id)");
    expect(migration).toContain("UNIQUE (organization_id_sha256, object_type, external_id)");
  });

  it("pins the migration after Account 360 and grants no delete authority", () => {
    expect(migration).toContain("version = 137");
    expect(migration).toContain("'customer_account_360_v1'");
    expect(migration).toContain("138,");
    expect(migration).toContain("'salesforce_read_sync_v1'");
    expect(migration).not.toMatch(/GRANT\s+(?:[A-Z]+,\s+)*DELETE\b/i);
  });
});
