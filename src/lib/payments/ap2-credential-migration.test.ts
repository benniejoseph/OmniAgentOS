import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260907190000_p9_17_ap2_credential_authorization.sql", import.meta.url),
  "utf8",
);

describe("P9.17 AP2 credential authorization migration", () => {
  it("installs forced actor RLS on grants and append-only claims", () => {
    expect(migration).toContain("omni_ap2_credential_grants");
    expect(migration).toContain("omni_ap2_credential_claims");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("AS PERMISSIVE FOR ALL");
    expect(migration).toContain("AP2 credential claims are append-only");
  });

  it("destroys the encrypted scoped authorization on every terminal transition", () => {
    expect(migration).toContain("OLD.sealed_authorization IS NULL OR NEW.sealed_authorization IS NOT NULL");
    expect(migration).toContain("state = 'consumed' AND sealed_authorization IS NULL");
    expect(migration).not.toContain("GRANT SELECT, INSERT, UPDATE ON omni_ap2_credential_claims");
  });

  it("records ordered migration 126", () => {
    expect(migration).toContain("version = 125");
    expect(migration).toContain("126,");
    expect(migration).toContain("ap2_credential_authorization_v1");
    expect(migration).toContain("58e206e5cf85d52958965d7ae06d89a1f61059ee41532970c3645b1dfff60708");
  });
});
