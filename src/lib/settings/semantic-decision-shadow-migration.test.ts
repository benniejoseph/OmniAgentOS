import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const schemaRunner = fs.readFileSync(
  path.join(process.cwd(), "src/lib/db/client.ts"),
  "utf8",
);
const schemaModule = fs.readFileSync(
  path.join(process.cwd(), "src/lib/db/semantic-decision-schema.ts"),
  "utf8",
);
const standaloneMigration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260918130000_semantic_decision_shadow_pilot.sql",
  ),
  "utf8",
);
const migrationManifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
) as Array<{ version: number; name: string; checksum: string }>;

describe("semantic decision shadow migration", () => {
  it("appends v184 after the exact v183 predecessor", () => {
    expect(migrationManifest.find((migration) => migration.version === 184)).toEqual({
      version: 184,
      name: "semantic_decision_shadow_pilot_v1",
      checksum:
        "142047c12f42ba8135d7bfd95edde467ebcedf4d42f5c69937b4fe797a865223",
    });
    expect(schemaRunner).toContain(
      "...databaseSchemaMigrations[183],\n      up: ensureSemanticDecisionShadowPilotV1",
    );
    expect(standaloneMigration).toContain("latest_version IS DISTINCT FROM 183");
    expect(standaloneMigration).toContain("version = 183");
    expect(standaloneMigration).toContain(
      "'actor_rls_policy_composition_repair_v1'",
    );
    expect(standaloneMigration).toContain(
      "VALUES (\n  184,\n  'semantic_decision_shadow_pilot_v1'",
    );
    expect(standaloneMigration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("keeps TypeSafe isolated to the no-fallback semantic scope", () => {
    for (const source of [schemaModule, standaloneMigration]) {
      expect(source).toContain("'semantic_decision'");
      expect(source).toContain("'typesafe'");
      expect(source).toContain("scope = 'semantic_decision'");
      expect(source).toContain("provider = 'typesafe'");
      expect(source).toContain("fallback_provider IS NULL");
      expect(source).toContain("NOT allow_cross_provider_fallback");
    }
    expect(standaloneMigration).toContain("'semantic_decision_shadow_pilot_v1'");
  });
});
