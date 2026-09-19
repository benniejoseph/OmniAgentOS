import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  BUILTIN_SKILL_ASSIGNMENT_LIMIT_V2,
  BUILTIN_SKILL_CATALOG_V2_IDS,
  BUILTIN_SKILL_CATALOG_V2_SCHEMA_SQL,
  ensureBuiltinSkillCatalogV2,
} from "@/lib/db/builtin-skill-catalog-schema";
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
) as Array<{ version: number; name: string; checksum: string }>;

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
    expect(BUILTIN_SKILL_CATALOG_V2_IDS).toEqual(
      BUILT_IN_SKILL_IDS.slice(0, 18),
    );
    expect(BUILTIN_SKILL_CATALOG_V2_IDS).toHaveLength(18);

    for (const sql of [
      BUILTIN_SKILL_CATALOG_V2_SCHEMA_SQL,
      standaloneMigration,
    ]) {
      const pinnedCatalogs = extractPinnedCatalogs(sql);
      expect(pinnedCatalogs).toHaveLength(2);
      for (const pinnedCatalog of pinnedCatalogs) {
        expect(pinnedCatalog).toEqual(BUILTIN_SKILL_CATALOG_V2_IDS);
      }
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
    expect(standaloneMigration).toContain(
      BUILTIN_SKILL_CATALOG_V2_SCHEMA_SQL.trim(),
    );
  });

  it("fails closed for existing assignments above the shared eight-Skill limit", () => {
    expect(BUILTIN_SKILL_ASSIGNMENT_LIMIT_V2).toBe(MAX_ASSIGNED_SKILLS);
    expect(MAX_ASSIGNED_SKILLS).toBe(8);
    for (const sql of [
      BUILTIN_SKILL_CATALOG_V2_SCHEMA_SQL,
      standaloneMigration,
    ]) {
      expect(sql.match(/cardinality\((?:agent|NEW)\.skill_ids\) > 8/g)).toHaveLength(4);
      expect(sql).not.toMatch(/cardinality\((?:agent|NEW)\.skill_ids\) > 30/);
      expect(sql).toContain(
        "Existing custom Agent Skill references are invalid for the built-in catalog or eight-Skill limit",
      );
      expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?omni_custom_agents\s+SET\s+skill_ids/i);
    }
  });

  it("rebuilds and exactly verifies both reference functions and triggers", () => {
    for (const sql of [
      BUILTIN_SKILL_CATALOG_V2_SCHEMA_SQL,
      standaloneMigration,
    ]) {
      expect(sql).toContain(
        "CREATE OR REPLACE FUNCTION public.omni_validate_custom_agent_skill_references()",
      );
      expect(sql).toContain(
        "CREATE OR REPLACE FUNCTION public.omni_protect_custom_skill_reference_identity()",
      );
      expect(sql).toContain("procedure.prosrc = expected_validator_body");
      expect(sql).toContain("procedure.prosrc = expected_protector_body");
      expect(sql).toContain(
        "DROP TRIGGER omni_custom_agents_validate_skill_references",
      );
      expect(sql).toContain(
        "DROP TRIGGER omni_custom_skills_protect_reference_identity",
      );
      expect(sql).toContain("trigger_record.tgtype = 23");
      expect(sql).toContain("trigger_record.tgtype = 31");
      expect(sql).toContain("trigger_record.tgtype = 34");
      expect(sql).toContain("FOR KEY SHARE OF custom_skill");
      expect(sql).toContain("agent.tenant_id COLLATE \"C\"");
      expect(sql).toContain("agent.actor_id COLLATE \"C\"");
    }
  });

  it("preserves schema ownership, forced RLS, and serving grant boundaries", () => {
    for (const sql of [
      BUILTIN_SKILL_CATALOG_V2_SCHEMA_SQL,
      standaloneMigration,
    ]) {
      expect(sql).toContain(
        "Built-in Skill catalog migration requires the schema owner",
      );
      expect(sql).toContain("LOCK TABLE omni_custom_agents, omni_custom_skills");
      expect(sql).toContain("NOT relation.relrowsecurity");
      expect(sql).toContain("NOT relation.relforcerowsecurity");
      expect(sql).toContain("policy.polname = 'omni_tenant_isolation'");
      expect(sql).toContain("'omni_tenant_visible(tenant_id)'");
      expect(sql).toContain("privilege.grantee <> procedure.proowner");
      expect(sql).toContain("REVOKE TRIGGER ON TABLE omni_custom_agents");
      expect(sql).toContain(
        "REVOKE TRIGGER, TRUNCATE ON TABLE omni_custom_skills",
      );
      expect(sql).not.toMatch(/GRANT\s+(?:TRIGGER|TRUNCATE|EXECUTE)/i);
    }
  });

  it("runs the immutable schema snapshot through one migration query", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await ensureBuiltinSkillCatalogV2({ query });
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(BUILTIN_SKILL_CATALOG_V2_SCHEMA_SQL);
  });
});
