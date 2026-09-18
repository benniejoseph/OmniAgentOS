import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260918150000_declarative_plugins.sql",
);
const migration = fs.readFileSync(migrationPath, "utf8");
const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
) as Array<{ version: number; name: string; checksum: string }>;

describe("declarative Plugin v1 migration", () => {
  it("is ordered after v185 and registered as v186", () => {
    expect(migration).toContain("latest_version IS DISTINCT FROM 185");
    expect(migration).toContain("mobile_push_receipt_canary_v1");
    expect(manifest.at(-1)).toEqual({
      version: 186,
      name: "declarative_plugins_v1",
      checksum: "0cb2bc195736819e3fd5c3a6ab44a8c48ca3dcc55b63d097a69aaf9824b06825",
    });
  });

  it("forces actor RLS, immutable receipts, and reversible installation state", () => {
    for (const table of [
      "omni_plugin_install_previews",
      "omni_plugin_installations",
      "omni_plugin_mutation_receipts",
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(migration).toContain("AS RESTRICTIVE FOR ALL TO PUBLIC");
    expect(migration).toContain("omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
    expect(migration).toContain("Plugin preview and mutation receipts are immutable");
    expect(migration).toContain("Plugin installations use reversible lifecycle state");
    expect(migration).toContain("Plugin lifecycle transition is invalid");
    expect(migration).toContain("Plugin reinstall requires a fresh exact preview");
    expect(migration).not.toMatch(/GRANT\s+DELETE|GRANT\s+TRUNCATE/i);
  });

  it("binds plugin-projected Skills to an exact actor installation", () => {
    expect(migration).toContain("source_plugin_installation_id TEXT");
    expect(migration).toContain("omni_custom_skills_plugin_installation_fkey");
    expect(migration).toContain(
      "FOREIGN KEY (tenant_id, actor_id, source_plugin_installation_id)",
    );
    expect(migration).toContain("omni_custom_skills_plugin_key_idx");
  });
});
