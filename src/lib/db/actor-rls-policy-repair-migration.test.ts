import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const schemaRunner = fs.readFileSync(
  path.join(process.cwd(), "src/lib/db/client.ts"),
  "utf8",
);
const actorPolicyRepairRunner = schemaRunner.slice(
  schemaRunner.indexOf("async function ensureActorRlsPolicyRepairV1"),
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
});
