import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationName = "moltbook_autonomy_privilege_repair_v1";
const migrationChecksum = createHash("sha256")
  .update(migrationName)
  .digest("hex");
const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260921200000_moltbook_autonomy_privilege_repair.sql",
), "utf8");
const manifest = JSON.parse(readFileSync(resolve(
  process.cwd(),
  "schema-migrations.json",
), "utf8")) as Array<{ version: number; name: string; checksum: string; file?: string }>;

describe("Moltbook autonomy privilege repair v195", () => {
  it("registers exactly after immutable v194 and runs from the migration file", () => {
    expect(migrationChecksum).toBe(
      "c02b2ca195cbb00c206320eb2074fed7981c282c356f1d4320c6c1ac866adf94",
    );
    const index = manifest.findIndex((entry) => entry.version === 195);
    expect(manifest[index]).toEqual({
      version: 195,
      name: migrationName,
      checksum: migrationChecksum,
      file: "20260921200000_moltbook_autonomy_privilege_repair.sql",
      sha256: "8e1a0b5cff9821b9dadccf58d90b7261830c14e4b688931f2679e6f51f2602d3",
    });
    expect(manifest[index - 1]?.version).toBe(194);
    expect(migration).toContain("latest_version IS DISTINCT FROM 194");
    expect(migration).toContain("name = 'moltbook_autonomy_v1'");
    expect(migration).toContain(
      "66a868eed1a0fef0eb61d8f69d0d2351605edf39711c007d5c58f1febb5cafef",
    );
  });

  it("isolates both private-table validators behind their exact triggers", () => {
    for (const functionName of [
      "omni_validate_moltbook_authority_version_v1",
      "omni_validate_moltbook_enrollment_v1",
    ]) {
      expect(migration).toContain(`ALTER FUNCTION public.${functionName}()`);
    }
    expect(migration.match(/SECURITY DEFINER/g)?.length).toBeGreaterThanOrEqual(3);
    expect(migration).toContain("SET search_path TO pg_catalog, public");
    expect(migration).toContain("omni_moltbook_authority_versions_validate");
    expect(migration).toContain("omni_moltbook_enrollments_validate");
    expect(migration).toContain("FROM omni_runtime");
    expect(migration).toContain("FROM omni_maintenance");
    expect(migration).not.toContain(
      "GRANT SELECT ON omni_auth_user_actor_identifiers",
    );
  });

  it("exposes only a scope-gated owner membership projection", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.omni_resolve_moltbook_owner_membership_v1(",
    );
    expect(migration).toContain("RETURNS TABLE (");
    expect(migration).toContain("canonical_actor_id TEXT");
    expect(migration).toContain("auth_user_id TEXT");
    expect(migration).toContain("membership_role TEXT");
    expect(migration).toContain("role_record.rolname = session_user");
    expect(migration).toContain("role_record.rolname = 'omni_maintenance'");
    expect(migration).toContain("role_record.rolbypassrls");
    expect(migration).toContain("public.omni_actor_scope_v1_allows(");
    expect(migration).toContain("membership.status = 'active'");
    expect(migration).toContain("membership.role IN ('operator', 'admin')");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION");
    expect(migration).toContain("has_table_privilege(");
    expect(migration).toContain("Runtime Moltbook private identity boundary is invalid");
    expect(migration).toContain("Maintenance Moltbook private identity boundary is invalid");
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|ALL)[\s\S]*omni_auth_(?:users|memberships|user_actor_identifiers)/i,
    );
  });
});
