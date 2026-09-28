import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BUILT_IN_SKILL_IDS } from "@/lib/skills/catalog";
import { MAX_ASSIGNED_SKILLS } from "@/lib/skills/limits";

const migrationName = "builtin_skill_catalog_v2";
const migrationChecksum = createHash("sha256")
  .update(migrationName)
  .digest("hex");
const standaloneMigration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260919120000_builtin_skill_catalog_v2.sql",
  ),
  "utf8",
);
const migrationManifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
) as Array<{ version: number; name: string; checksum: string; file?: string }>;

function extractPinnedCatalogs(sql: string) {
  return [...sql.matchAll(
    /built_in_skill_ids CONSTANT TEXT\[\] := ARRAY\[\n([\s\S]*?)\n\s*\];/g,
  )].map((match) =>
    [...(match[1] ?? "").matchAll(/'([^']+)'/g)].map(
      (idMatch) => idMatch[1] ?? "",
    ),
  );
}

describe("built-in Skill catalog v2 migration", () => {
  it("keeps the released v2 allowlist immutable", () => {
    const releasedCatalog = BUILT_IN_SKILL_IDS.slice(0, 18);
    expect(releasedCatalog).toHaveLength(18);

    const pinnedCatalogs = extractPinnedCatalogs(standaloneMigration);
    expect(pinnedCatalogs).toHaveLength(2);
    for (const pinnedCatalog of pinnedCatalogs) {
      expect(pinnedCatalog).toEqual(releasedCatalog);
    }
  });

  it("appends an exact v187 migration after declarative Plugins", () => {
    expect(migrationChecksum).toBe(
      "fe690251c625bd3a55932b5a58c26509df6bc283cb24a1dd7c6373a1ce0a3a9c",
    );
    expect(migrationManifest.find((migration) => migration.version === 187)).toEqual({
      version: 187,
      name: migrationName,
      checksum: migrationChecksum,
      file: "20260919120000_builtin_skill_catalog_v2.sql",
    });
    expect(standaloneMigration).toContain("latest_version IS DISTINCT FROM 186");
    expect(standaloneMigration).toContain("version = 186");
    expect(standaloneMigration).toContain("'declarative_plugins_v1'");
    expect(standaloneMigration).toContain(
      "0cb2bc195736819e3fd5c3a6ab44a8c48ca3dcc55b63d097a69aaf9824b06825",
    );
    expect(standaloneMigration).toContain(
      "VALUES (\n  187,\n  'builtin_skill_catalog_v2'",
    );
    expect(standaloneMigration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("fails closed for existing assignments above the shared eight-Skill limit", () => {
    expect(MAX_ASSIGNED_SKILLS).toBe(8);
    expect(standaloneMigration.match(/cardinality\((?:agent|NEW)\.skill_ids\) > 8/g)).toHaveLength(4);
    expect(standaloneMigration).not.toMatch(/cardinality\((?:agent|NEW)\.skill_ids\) > 30/);
    expect(standaloneMigration).toContain(
      "Existing custom Agent Skill references are invalid for the built-in catalog or eight-Skill limit",
    );
    expect(standaloneMigration).not.toMatch(/UPDATE\s+(?:public\.)?omni_custom_agents\s+SET\s+skill_ids/i);
  });

  it("rebuilds and exactly verifies both reference functions and triggers", () => {
    expect(standaloneMigration).toContain(
      "CREATE OR REPLACE FUNCTION public.omni_validate_custom_agent_skill_references()",
    );
    expect(standaloneMigration).toContain(
      "CREATE OR REPLACE FUNCTION public.omni_protect_custom_skill_reference_identity()",
    );
    expect(standaloneMigration).toContain("procedure.prosrc = expected_validator_body");
    expect(standaloneMigration).toContain("procedure.prosrc = expected_protector_body");
    expect(standaloneMigration).toContain(
      "DROP TRIGGER omni_custom_agents_validate_skill_references",
    );
    expect(standaloneMigration).toContain(
      "DROP TRIGGER omni_custom_skills_protect_reference_identity",
    );
    expect(standaloneMigration).toContain("trigger_record.tgtype = 23");
    expect(standaloneMigration).toContain("trigger_record.tgtype = 31");
    expect(standaloneMigration).toContain("trigger_record.tgtype = 34");
    expect(standaloneMigration).toContain("FOR KEY SHARE OF custom_skill");
    expect(standaloneMigration).toContain("agent.tenant_id COLLATE \"C\"");
    expect(standaloneMigration).toContain("agent.actor_id COLLATE \"C\"");
  });

  it("preserves schema ownership, forced RLS, and serving grant boundaries", () => {
    expect(standaloneMigration).toContain(
      "Built-in Skill catalog migration requires the schema owner",
    );
    expect(standaloneMigration).toContain("LOCK TABLE omni_custom_agents, omni_custom_skills");
    expect(standaloneMigration).toContain("NOT relation.relrowsecurity");
    expect(standaloneMigration).toContain("NOT relation.relforcerowsecurity");
    expect(standaloneMigration).toContain("policy.polname = 'omni_tenant_isolation'");
    expect(standaloneMigration).toContain("'omni_tenant_visible(tenant_id)'");
    expect(standaloneMigration).toContain("privilege.grantee <> procedure.proowner");
    expect(standaloneMigration).toContain("REVOKE TRIGGER ON TABLE omni_custom_agents");
    expect(standaloneMigration).toContain(
      "REVOKE TRIGGER, TRUNCATE ON TABLE omni_custom_skills",
    );
    expect(standaloneMigration).not.toMatch(/GRANT\s+(?:TRIGGER|TRUNCATE|EXECUTE)/i);
  });
});
