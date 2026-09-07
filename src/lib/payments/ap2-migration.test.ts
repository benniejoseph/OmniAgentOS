import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260907170000_p9_16_ap2_human_present_mandates.sql", import.meta.url),
  "utf8",
);

describe("P9.16 AP2 durable ledger migration", () => {
  it("installs forced actor RLS on all three payment tables", () => {
    expect(migration).toContain("omni_ap2_signing_credentials");
    expect(migration).toContain("omni_ap2_mandate_reviews");
    expect(migration).toContain("omni_ap2_mandate_authorizations");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("AS PERMISSIVE FOR ALL");
    expect(migration).toContain("omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
  });

  it("makes authorization proofs append-only and forbids deletion", () => {
    expect(migration).toContain("AP2 mandate authorizations are append-only");
    expect(migration).toContain("cannot be deleted or truncated");
    expect(migration).toContain("GRANT SELECT, INSERT ON omni_ap2_mandate_authorizations");
    expect(migration).not.toContain("GRANT SELECT, INSERT, UPDATE ON omni_ap2_mandate_authorizations");
  });

  it("records ordered migration 125", () => {
    expect(migration).toContain("version = 124");
    expect(migration).toContain("125,");
    expect(migration).toContain("ap2_human_present_mandates_v1");
    expect(migration).toContain("f8b75e5d61a3a347649d82909e8e18e6f174079d37a5609643df768c0c9031a5");
  });
});
