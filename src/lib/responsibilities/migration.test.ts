import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSqlMigrationFile, sqlMigrationFileDigest } from "@/lib/db/sql-migration-files";
import { migrationScopedTenantTables, tenantRootPolicyTables } from "@/lib/db/schema/tenant-isolation";
const manifest = JSON.parse(fs.readFileSync("schema-migrations.json", "utf8")) as Array<{ version: number; name: string; checksum: string; file?: string; sha256?: string }>;
const entry = manifest.find((value) => value.version === 216)!;
const source = fs.readFileSync(path.join("supabase/migrations", entry.file!), "utf8");
describe("Responsibility draft migration source", () => {
  it("pins its exact predecessor and normalized file identity", () => {
    const previous = manifest.find((value) => value.version === 215)!;
    expect(source).toContain("IF latest_version IS DISTINCT FROM 215 OR (");
    expect(source).toContain(`AND name = '${previous.name}'`);
    expect(source).toContain(`AND checksum = '${previous.checksum}'`);
    expect(entry.checksum).toBe(sqlMigrationFileDigest(source, [entry.checksum]));
    expect(entry.sha256).toBe(entry.checksum);
    expect(parseSqlMigrationFile(entry.file!, source).ledger).toEqual([{ version: 216, name: "responsibility_drafts_v1", checksum: entry.checksum }]);
  });
  it("keeps exact actor RLS and immutable receipts in migration-owned tables", () => {
    for (const table of ["omni_responsibilities", "omni_responsibility_mutations"] as const) {
      expect(migrationScopedTenantTables).toContain(table);
      expect(tenantRootPolicyTables as readonly string[]).not.toContain(table);
      expect(source).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
      expect(source).toContain(`ON public.${table} AS RESTRICTIVE FOR ALL TO PUBLIC`);
    }
    expect(source).toContain("omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id)");
    expect(source).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(source).toContain("NEW.revision <> OLD.revision + 1");
    expect(source).not.toMatch(/GRANT (?:ALL|DELETE|TRUNCATE)/);
    expect(source).not.toMatch(/INSERT INTO public\.(?:omni_workflow_triggers|omni_agent_runs|omni_operation_jobs|omni_personal_notifications)/);
  });
});
