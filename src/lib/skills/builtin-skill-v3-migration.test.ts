import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_SKILL_ASSIGNMENT_LIMIT_V3,
  BUILTIN_SKILL_CATALOG_V3_IDS,
  BUILTIN_SKILL_CATALOG_V3_SCHEMA_SQL,
  ensureBuiltinSkillCatalogV3,
} from "@/lib/db/builtin-skill-catalog-v3-schema";
import { BUILT_IN_SKILL_IDS } from "@/lib/skills/catalog";
import { MAX_ASSIGNED_SKILLS } from "@/lib/skills/limits";

const migrationName = "builtin_skill_catalog_v3";
const migrationChecksum = createHash("sha256")
  .update(migrationName)
  .digest("hex");
const standaloneMigration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260919143000_builtin_skill_catalog_v3.sql",
  ),
  "utf8",
);
const migrationManifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
) as Array<{ version: number; name: string; checksum: string }>;

describe("built-in Skill catalog v3 migration", () => {
  it("pins the complete 19-Skill catalog including Document studio", () => {
    expect(BUILTIN_SKILL_CATALOG_V3_IDS).toEqual(BUILT_IN_SKILL_IDS);
    expect(BUILTIN_SKILL_CATALOG_V3_IDS).toHaveLength(19);
    expect(BUILTIN_SKILL_CATALOG_V3_IDS.at(-1)).toBe(
      "creation.document-studio",
    );
    for (const sql of [
      BUILTIN_SKILL_CATALOG_V3_SCHEMA_SQL,
      standaloneMigration,
    ]) {
      expect(sql).toContain("built_in_skill_ids CONSTANT TEXT[] := ARRAY[");
      for (const id of BUILTIN_SKILL_CATALOG_V3_IDS) {
        expect(sql).toContain(`'${id}'`);
      }
    }
  });

  it("appends exact ordered migration v188 after immutable v187", () => {
    expect(migrationChecksum).toBe(
      "4c206314533b7812aff807d551f1b1514987582b64c21e1c17378ac0c592deb1",
    );
    expect(migrationManifest.find((migration) => migration.version === 188))
      .toEqual({
        version: 188,
        name: migrationName,
        checksum: migrationChecksum,
      });
    expect(standaloneMigration).toContain(
      "latest_version IS DISTINCT FROM 187",
    );
    expect(standaloneMigration).toContain("'builtin_skill_catalog_v2'");
    expect(standaloneMigration).toContain(
      "VALUES (\n  188,\n  'builtin_skill_catalog_v3'",
    );
    expect(standaloneMigration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("rebuilds only the exact verified v2 allowlist literal", () => {
    for (const sql of [
      BUILTIN_SKILL_CATALOG_V3_SCHEMA_SQL,
      standaloneMigration,
    ]) {
      expect(sql).toContain("quote_literal(previous_skill_ids::TEXT)");
      expect(sql).toContain("quote_literal(built_in_skill_ids::TEXT)");
      expect(sql).toContain(
        "Built-in Skill catalog v2 guard body changed before v3",
      );
      expect(sql).toContain(
        "CREATE OR REPLACE FUNCTION public.omni_validate_custom_agent_skill_references()",
      );
      expect(sql).toContain(
        "CREATE OR REPLACE FUNCTION public.omni_protect_custom_skill_reference_identity()",
      );
      expect(sql).toContain("procedure.prosrc = validator_body");
      expect(sql).toContain("procedure.prosrc = protector_body");
      expect(sql).toContain("trigger_record.tgtype = 23");
      expect(sql).toContain("trigger_record.tgtype = 31");
      expect(sql).toContain("trigger_record.tgtype = 34");
      expect(sql).toContain("NOT relation.relrowsecurity");
      expect(sql).toContain("NOT relation.relforcerowsecurity");
    }
  });

  it("retains the shared eight-Skill bound and fails on custom collisions", () => {
    expect(BUILTIN_SKILL_ASSIGNMENT_LIMIT_V3).toBe(MAX_ASSIGNED_SKILLS);
    expect(MAX_ASSIGNED_SKILLS).toBe(8);
    for (const sql of [
      BUILTIN_SKILL_CATALOG_V3_SCHEMA_SQL,
      standaloneMigration,
    ]) {
      expect(sql).toContain("cardinality(agent.skill_ids) > 8");
      expect(sql).toContain(
        'custom_skill.id COLLATE "C" = ANY (built_in_skill_ids)',
      );
      expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?omni_custom_agents\s+SET\s+skill_ids/i);
    }
  });

  it("executes the runtime schema as one migration statement", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await ensureBuiltinSkillCatalogV3({ query });
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(BUILTIN_SKILL_CATALOG_V3_SCHEMA_SQL);
  });
});
