import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const readMigration = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), "supabase/migrations", file), "utf8");
const historicalRepair = readMigration(
  "20260907123000_p9_actor_rls_policy_repair.sql",
);
const compositionRepair = readMigration(
  "20260918120000_actor_rls_policy_composition_repair.sql",
);
const migrationManifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
) as Array<{ version: number; name: string; checksum: string; file?: string }>;

describe("actor RLS policy composition repair", () => {
  it("replaces the permissive actor policy that v123 installs with a restrictive one", () => {
    // v123 runs from its file, which still installs the actor policy as
    // permissive; v183 must follow it on every database.
    expect(historicalRepair).toContain(
      "CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL",
    );
    expect(compositionRepair).toContain(
      "'DROP POLICY IF EXISTS %I ON public.%I',\n      table_name || '_actor', table_name",
    );
    expect(compositionRepair).toContain(
      "'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC USING (omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))",
    );
    expect(compositionRepair).not.toContain(
      "'CREATE POLICY %I ON public.%I AS PERMISSIVE",
    );
    expect(compositionRepair).toContain("AND NOT policy.polpermissive");
    expect(compositionRepair).toContain(
      "AND policy.polname = 'omni_tenant_isolation'",
    );
    expect(compositionRepair).toContain("AND policy.polpermissive");
  });

  it("verifies both policies use their exact tenant and actor predicates", () => {
    expect(compositionRepair).toContain(
      "'(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))'",
    );
    expect(compositionRepair).toContain(
      "'omni_tenant_visible(tenant_id)'",
    );
    expect(compositionRepair.match(/pg_get_expr\(policy\.polqual/g)).toHaveLength(2);
    expect(
      compositionRepair.match(/pg_get_expr\(policy\.polwithcheck/g),
    ).toHaveLength(2);
  });

  it("appends a production repair after v182", () => {
    expect(migrationManifest.find((migration) => migration.version === 123)?.file).toBe(
      "20260907123000_p9_actor_rls_policy_repair.sql",
    );
    expect(migrationManifest.find((migration) => migration.version === 183)).toEqual({
      version: 183,
      name: "actor_rls_policy_composition_repair_v1",
      checksum:
        "06e06bfc319278f8e676d14c30bfc34f60cdda305ff48b0c4f4944a01e53ba97",
      file: "20260918120000_actor_rls_policy_composition_repair.sql",
    });
    expect(compositionRepair).toContain("latest_version IS DISTINCT FROM 182");
    expect(compositionRepair).toContain("version = 182");
    expect(compositionRepair).toContain(
      "'p13_3_local_computer_open_url_action_v1'",
    );
    expect(compositionRepair).toContain(
      "VALUES (\n  183,\n  'actor_rls_policy_composition_repair_v1'",
    );
    expect(compositionRepair.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("converges existing databases on exactly two public policies per table", () => {
    expect(compositionRepair).toContain(
      "CREATE POLICY omni_tenant_isolation ON",
    );
    expect(compositionRepair).toContain("AS PERMISSIVE FOR ALL TO PUBLIC");
    expect(compositionRepair).toContain("AS RESTRICTIVE FOR ALL TO PUBLIC");
    expect(compositionRepair).toContain("AND policy.polroles = ARRAY[0::OID]");
    expect(compositionRepair).toContain(
      "(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))",
    );
    expect(compositionRepair).toContain("omni_tenant_visible(tenant_id)");
    expect(compositionRepair).toContain(
      ") <> 2 * cardinality(expected_tables) THEN",
    );
  });
});
