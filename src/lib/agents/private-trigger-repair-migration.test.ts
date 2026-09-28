import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(join(
  process.cwd(),
  "supabase/migrations/20260921150000_agent_private_trigger_privilege_repair.sql",
), "utf8");
const manifest = JSON.parse(readFileSync(
  join(process.cwd(), "schema-migrations.json"),
  "utf8",
)) as Array<{ version: number; name: string; checksum: string; file?: string }>;

describe("agent private trigger privilege repair v1", () => {
  it("pins the definition-validator repair predecessor", () => {
    expect(migration).toContain("latest_version IS DISTINCT FROM 191");
    expect(migration).toContain(
      "name = 'agent_identity_validator_privilege_repair_v1'",
    );
    expect(migration).toContain(
      "225d62212d28a5c6186d0e62d402a61e0283bfd34695f1f8aa25b2e1132593f2",
    );
  });

  it("isolates both canonical-actor validators behind trigger execution", () => {
    expect(migration).toContain(
      "ALTER FUNCTION public.omni_validate_execution_principal_insert()",
    );
    expect(migration).toContain(
      "ALTER FUNCTION public.omni_enforce_moltbook_connection_agent_boundary_v1()",
    );
    expect(migration.match(/SECURITY DEFINER/g)?.length).toBeGreaterThanOrEqual(2);
    expect(migration).toContain("SET search_path TO pg_catalog, public");
    expect(migration).not.toContain(
      "GRANT SELECT ON omni_auth_user_actor_identifiers",
    );
  });

  it("verifies both trigger bindings and publishes the marker", () => {
    expect(migration).toContain("omni_execution_principal_validate_insert");
    expect(migration).toContain("omni_moltbook_connections_agent_boundary");
    expect(migration).toContain("privilege.grantee = 0");
    expect(manifest.find((entry) => entry.version === 192)).toEqual({
      version: 192,
      name: "agent_private_trigger_privilege_repair_v1",
      checksum:
        "a8beaa32d24c97ad6763801982c474414ab93a046f98d91fc3df30bb9e172fab",
      file: "20260921150000_agent_private_trigger_privilege_repair.sql",
      sha256:
        "d6753b11d1742f9b02172979cef23cf8f8d1547f9635e5bca3d44f760188a573",
    });
  });
});
