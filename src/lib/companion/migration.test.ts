import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSqlMigrationFile, sqlMigrationFileDigest } from "@/lib/db/sql-migration-files";
import { migrationScopedTenantTables, tenantRootPolicyTables } from "@/lib/db/schema/tenant-isolation";

const manifest = JSON.parse(fs.readFileSync("schema-migrations.json", "utf8")) as Array<{
  version: number; name: string; file?: string; checksum: string; sha256?: string;
}>;
const entry = manifest.find((value) => value.version === 215)!;
const source = fs.readFileSync(path.join("supabase/migrations", entry.file!), "utf8");

describe("Companion preference migration source", () => {
  it("pins its predecessor and self-normalized digest and parses as one bounded ordered migration", () => {
    const previous = manifest.find((value) => value.version === 214)!;
    expect(source).toContain("IF latest_version IS DISTINCT FROM 214 OR (");
    expect(source).toContain(`AND name = '${previous.name}'`);
    expect(source).toContain(`AND checksum = '${previous.checksum}'`);
    expect(entry.checksum).toBe(sqlMigrationFileDigest(source, [entry.checksum]));
    expect(entry.sha256).toBe(entry.checksum);
    expect(parseSqlMigrationFile(entry.file!, source).ledger).toEqual([{ version: 215, name: "companion_preferences_v1", checksum: entry.checksum }]);
  });

  it("enrolls both tables only in migration-owned isolation verification and preserves restrictive actor policies", () => {
    for (const table of ["omni_companion_preferences", "omni_companion_preference_mutations"] as const) {
      expect(migrationScopedTenantTables).toContain(table);
      expect(tenantRootPolicyTables as readonly string[]).not.toContain(table);
      expect(source).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;`);
      expect(source).toContain(`ON public.${table} AS RESTRICTIVE FOR ALL TO PUBLIC`);
    }
    expect(source).toContain("omni_actor_scope_v1_allows_validated((SELECT public.omni_current_actor_scope_v1()), tenant_id, actor_id)");
  });

  it("retains saved home identities and restricts revision/receipt changes instead of executing work", () => {
    expect(source).not.toContain("REFERENCES public.omni_threads");
    expect(source).toContain("NEW.revision <> OLD.revision + 1");
    expect(source).toContain("Companion preference receipts are immutable");
    expect(source).toContain("Companion receipt does not match the saved preference revision");
    expect(source).not.toMatch(/GRANT (?:ALL|DELETE|TRUNCATE)/);
    expect(source).not.toMatch(/INSERT INTO public\.(?:omni_agent_runs|omni_operation_jobs|omni_events|omni_personal_notifications)/);
  });
});
