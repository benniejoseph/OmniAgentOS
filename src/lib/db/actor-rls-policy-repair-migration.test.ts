import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const schemaRunner = fs.readFileSync(
  path.join(process.cwd(), "src/lib/db/client.ts"),
  "utf8",
);
const standaloneRepair = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260918120000_actor_rls_policy_composition_repair.sql",
  ),
  "utf8",
);
const migrationManifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
) as Array<{ version: number; name: string; checksum: string }>;
const actorPolicyRepairRunner = schemaRunner.slice(
  schemaRunner.indexOf("async function ensureActorRlsPolicyRepairV1"),
  schemaRunner.indexOf(
    "async function ensureActorRlsPolicyCompositionRepairV1",
  ),
);
const actorPolicyCompositionRepairRunner = schemaRunner.slice(
  schemaRunner.indexOf(
    "async function ensureActorRlsPolicyCompositionRepairV1",
  ),
  schemaRunner.indexOf("async function ensureAp2HumanPresentMandatesV1"),
);

describe("embedded actor RLS policy repair", () => {
  it("requires the permissive tenant boundary and restrictive actor boundary", () => {
    expect(actorPolicyRepairRunner).toContain(
      "CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL",
    );
    expect(actorPolicyRepairRunner).not.toContain(
      "CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL",
    );
    expect(actorPolicyRepairRunner).toContain(
      "AND NOT policy.polpermissive",
    );
    expect(actorPolicyRepairRunner).toContain(
      "AND policy.polname = 'omni_tenant_isolation'",
    );
    expect(actorPolicyRepairRunner).toContain(
      "AND policy.polpermissive",
    );
    expect(actorPolicyRepairRunner).toContain(
      ") <> 2 * cardinality(expected_tables) THEN",
    );
  });

  it("verifies both policies use their exact tenant and actor predicates", () => {
    expect(actorPolicyRepairRunner).toContain(
      "'(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))'",
    );
    expect(actorPolicyRepairRunner).toContain(
      "'omni_tenant_visible(tenant_id)'",
    );
    expect(actorPolicyRepairRunner.match(/pg_get_expr\(policy\.polqual/g)).toHaveLength(2);
    expect(
      actorPolicyRepairRunner.match(/pg_get_expr\(policy\.polwithcheck/g),
    ).toHaveLength(2);
  });

  it("appends a production repair after v182", () => {
    expect(migrationManifest.at(-1)).toEqual({
      version: 183,
      name: "actor_rls_policy_composition_repair_v1",
      checksum:
        "06e06bfc319278f8e676d14c30bfc34f60cdda305ff48b0c4f4944a01e53ba97",
    });
    expect(schemaRunner).toContain(
      "...databaseSchemaMigrations[182],\n      up: ensureActorRlsPolicyCompositionRepairV1",
    );
    expect(standaloneRepair).toContain("latest_version IS DISTINCT FROM 182");
    expect(standaloneRepair).toContain("version = 182");
    expect(standaloneRepair).toContain(
      "'p13_3_local_computer_open_url_action_v1'",
    );
    expect(standaloneRepair).toContain(
      "VALUES (\n  183,\n  'actor_rls_policy_composition_repair_v1'",
    );
    expect(standaloneRepair.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("converges existing databases on exactly two public policies per table", () => {
    for (const source of [actorPolicyCompositionRepairRunner, standaloneRepair]) {
      expect(source).toContain(
        "CREATE POLICY omni_tenant_isolation ON",
      );
      expect(source).toContain("AS PERMISSIVE FOR ALL TO PUBLIC");
      expect(source).toContain("AS RESTRICTIVE FOR ALL TO PUBLIC");
      expect(source).toContain("AND policy.polroles = ARRAY[0::OID]");
      expect(source).toContain(
        "(omni_system_scope_enabled() OR omni_actor_scope_v1_allows(tenant_id, owner_actor_id))",
      );
      expect(source).toContain("omni_tenant_visible(tenant_id)");
      expect(source).toContain(
        ") <> 2 * cardinality(expected_tables) THEN",
      );
    }
  });
});
