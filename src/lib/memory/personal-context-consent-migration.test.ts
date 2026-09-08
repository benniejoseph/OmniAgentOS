import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PERSONAL_CONTEXT_CONSENT_SCHEMA_SQL } from "@/lib/db/personal-context-consent-schema";
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
    const boundaries = [migration, PERSONAL_CONTEXT_CONSENT_SCHEMA_SQL];

    for (const sql of boundaries) {
      expect(sql).toContain(PERSONAL_CONTEXT_CONSENT_CONTRACT_ID);
      expect(sql).toContain(PERSONAL_CONTEXT_NOTICE_CONTRACT_ID);
      expect(sql).toContain(PERSONAL_CONTEXT_NOTICE_SHA256);
      expect(sql).toContain("omni_actor_scope_v1_allows_canonical");
      expect(sql).toContain("FORCE ROW LEVEL SECURITY");
      expect(sql).toContain("Personal-context consent history is immutable");
      expect(sql).not.toMatch(/GRANT\s+(?:ALL|DELETE|TRUNCATE)\b/i);
    }
    expect(migration).toContain("personal_context_consent_v1");
    expect(migration).toContain("version, name, checksum, applied_at");
  });
});
