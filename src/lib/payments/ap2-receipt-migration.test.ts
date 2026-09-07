import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260907200000_p9_18_ap2_receipt_reconciliation.sql", import.meta.url),
  "utf8",
);

describe("P9.18 AP2 receipt reconciliation migration", () => {
  it("installs actor-private append-only evidence and a derived projection", () => {
    expect(migration).toContain("omni_ap2_payment_transactions");
    expect(migration).toContain("omni_ap2_payment_receipts");
    expect(migration).toContain("omni_ap2_reconciliation_observations");
    expect(migration).toContain("omni_ap2_reconciliation_jobs");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("receipts and reconciliation observations are append-only");
  });

  it("derives paid state and limits mutable runtime access", () => {
    expect(migration).toContain("paid = (canonical_status IN");
    expect(migration).toContain("NEW.lifecycle_revision <> OLD.lifecycle_revision + 1");
    expect(migration).not.toContain("GRANT SELECT, INSERT, UPDATE ON omni_ap2_payment_receipts");
    expect(migration).not.toContain("GRANT SELECT, INSERT, UPDATE ON omni_ap2_reconciliation_observations");
  });

  it("records ordered migration 127", () => {
    expect(migration).toContain("version = 126");
    expect(migration).toContain("127,");
    expect(migration).toContain("ap2_receipt_reconciliation_v1");
    expect(migration).toContain("b85bf6d553f897caa31d67ec907d5abf308572652dd45524da150e4ec4a60acb");
  });
});
