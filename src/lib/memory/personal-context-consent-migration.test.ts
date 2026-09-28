import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  PERSONAL_CONTEXT_CONSENT_CONTRACT_ID,
  PERSONAL_CONTEXT_NOTICE_CONTRACT_ID,
  PERSONAL_CONTEXT_NOTICE_SHA256,
} from "@/lib/memory/personal-context-consent";

describe("personal-context consent migration", () => {
  it("pins the contract, exact actor RLS, immutable history, and narrow grants", async () => {
    const migration = await readFile(
      new URL(
        "../../../supabase/migrations/20260908153000_personal_context_consent.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain(PERSONAL_CONTEXT_CONSENT_CONTRACT_ID);
    expect(migration).toContain(PERSONAL_CONTEXT_NOTICE_CONTRACT_ID);
    expect(migration).toContain(PERSONAL_CONTEXT_NOTICE_SHA256);
    expect(migration).toContain("omni_actor_scope_v1_allows_canonical");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("Personal-context consent history is immutable");
    expect(migration).toContain(
      "REVOKE ALL ON TABLE omni_personal_context_consents FROM omni_runtime",
    );
    expect(migration).toContain(
      "REVOKE ALL ON TABLE omni_personal_context_consents FROM omni_maintenance",
    );
    expect(migration).toContain(
      "REVOKE ALL ON TABLE omni_personal_context_consents FROM omni_backup",
    );
    expect(migration).not.toMatch(/GRANT\s+(?:ALL|DELETE|TRUNCATE)\b/i);
    expect(migration).toContain("personal_context_consent_v1");
    expect(migration).toContain("version, name, checksum, applied_at");
  });
});
