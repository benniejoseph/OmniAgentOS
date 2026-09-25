import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(join(
  process.cwd(),
  "supabase/migrations/20260921153000_execution_principal_row_validator_grant.sql",
), "utf8");
const runtimeRepair = readFileSync(join(
  process.cwd(),
  "src/lib/agents/identity-schema.ts",
), "utf8");
const manifest = JSON.parse(readFileSync(
  join(process.cwd(), "schema-migrations.json"),
  "utf8",
)) as Array<{ version: number; name: string; checksum: string }>;

describe("execution principal row validator grant v1", () => {
  it("pins the private-trigger repair predecessor", () => {
    expect(migration).toContain("latest_version IS DISTINCT FROM 192");
    expect(migration).toContain(
      "name = 'agent_private_trigger_privilege_repair_v1'",
    );
    expect(migration).toContain(
      "a8beaa32d24c97ad6763801982c474414ab93a046f98d91fc3df30bb9e172fab",
    );
  });

  it("grants only the immutable row validator to writer roles", () => {
    for (const source of [migration, runtimeRepair]) {
      expect(source).toContain("omni_execution_principal_row_is_valid(");
      expect(source).toContain("TO omni_runtime");
      expect(source).toContain("TO omni_maintenance");
      expect(source).toContain("procedure.provolatile = 'i'");
      expect(source).toContain("NOT procedure.prosecdef");
      expect(source).not.toContain(
        "GRANT SELECT ON omni_auth_user_actor_identifiers",
      );
    }
  });

  it("publishes the ordered schema marker", () => {
    expect(manifest.find((entry) => entry.version === 193)).toEqual({
      version: 193,
      name: "execution_principal_row_validator_grant_v1",
      checksum:
        "9b787d1cfa1d6ae007cf8594f43c00045bab640b1f596e91d330923acc3bf2f7",
    });
  });
});
