import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(join(
  process.cwd(),
  "supabase/migrations/20260921143000_agent_identity_validator_privilege_repair.sql",
), "utf8");
const runtimeRepair = readFileSync(join(
  process.cwd(),
  "src/lib/agents/identity-schema.ts",
), "utf8");
const manifest = JSON.parse(readFileSync(
  join(process.cwd(), "schema-migrations.json"),
  "utf8",
)) as Array<{ version: number; name: string; checksum: string }>;

describe("agent identity validator privilege repair v1", () => {
  it("pins the Moltbook schema predecessor", () => {
    expect(migration).toContain("latest_version IS DISTINCT FROM 190");
    expect(migration).toContain("name = 'moltbook_agent_connections_v1'");
    expect(migration).toContain(
      "e0b8c00ca8f4fce6139735623366cacfa97675419a57c1666b4bf0fe4bbe8e46",
    );
  });

  it("uses a fixed-path definer trigger without exposing actor identifiers", () => {
    for (const source of [migration, runtimeRepair]) {
      expect(source).toContain(
        "ALTER FUNCTION public.omni_validate_agent_definition_version_v1()",
      );
      expect(source).toContain("SECURITY DEFINER");
      expect(source).toContain("SET search_path TO pg_catalog, public");
      expect(source).toContain("FROM PUBLIC");
      expect(source).toContain("FROM omni_runtime");
      expect(source).toContain("FROM omni_maintenance");
      expect(source).not.toContain(
        "GRANT SELECT ON omni_auth_user_actor_identifiers",
      );
    }
  });

  it("verifies the repaired trigger and publishes the immutable marker", () => {
    expect(migration).toContain("procedure.prosecdef");
    expect(migration).toContain("privilege.grantee = 0");
    expect(migration).toContain("omni_agent_definition_version_validate");
    expect(manifest.at(-1)).toEqual({
      version: 191,
      name: "agent_identity_validator_privilege_repair_v1",
      checksum:
        "225d62212d28a5c6186d0e62d402a61e0283bfd34695f1f8aa25b2e1132593f2",
    });
  });
});
