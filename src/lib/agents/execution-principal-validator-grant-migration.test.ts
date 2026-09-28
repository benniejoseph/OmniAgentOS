import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(join(
  process.cwd(),
  "supabase/migrations/20260921153000_execution_principal_row_validator_grant.sql",
), "utf8");
const manifest = JSON.parse(readFileSync(
  join(process.cwd(), "schema-migrations.json"),
  "utf8",
)) as Array<{ version: number; name: string; checksum: string; file?: string }>;

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
    expect(migration).toContain("omni_execution_principal_row_is_valid(");
    expect(migration).toContain("TO omni_runtime");
    expect(migration).toContain("TO omni_maintenance");
    expect(migration).toContain("procedure.provolatile = 'i'");
    expect(migration).toContain("NOT procedure.prosecdef");
    expect(migration).not.toContain(
      "GRANT SELECT ON omni_auth_user_actor_identifiers",
    );
  });

  it("publishes the ordered schema marker", () => {
    expect(manifest.find((entry) => entry.version === 193)).toEqual({
      version: 193,
      name: "execution_principal_row_validator_grant_v1",
      checksum:
        "9b787d1cfa1d6ae007cf8594f43c00045bab640b1f596e91d330923acc3bf2f7",
      file: "20260921153000_execution_principal_row_validator_grant.sql",
      sha256:
        "7fc4e4174c32d0d3e4f10d617c2367702f74722a97658a09108d88554c5ff8db",
    });
  });
});
