import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseSqlMigrationFile, sqlMigrationFileDigest } from "@/lib/db/sql-migration-files";

const manifest = JSON.parse(fs.readFileSync("schema-migrations.json", "utf8")) as Array<{
  version: number; name: string; checksum: string; file: string; sha256: string;
}>;
const read = (version: number) => {
  const entry = manifest.find((item) => item.version === version)!;
  return { entry, source: fs.readFileSync(path.join("supabase/migrations", entry.file), "utf8") };
};
const targets = (sql: string) => [...sql.matchAll(
  /\('(omni_\w+)',\n +'(omni_\w+)',\n +'((?:[^']|'')*)'\)/g,
)].map(([, table, name, definition]) => ({ table, name, definition }));

describe("restore qualification and deferred validation migrations", () => {
  it.each([213, 214])("pins v%i to its exact predecessor and file digest", (version) => {
    const { entry, source } = read(version);
    const predecessor = manifest.find((item) => item.version === version - 1)!;
    expect(source).toContain(`IF latest_version IS DISTINCT FROM ${predecessor.version} OR (`);
    expect(source).toContain(`AND name = '${predecessor.name}'`);
    expect(source).toContain(`AND checksum = '${predecessor.checksum}'`);
    expect(entry.checksum).toBe(sqlMigrationFileDigest(source, [entry.checksum]));
    expect(entry.sha256).toBe(entry.checksum);
    expect(parseSqlMigrationFile(entry.file, source).ledger).toEqual([{
      version, name: entry.name, checksum: entry.checksum,
    }]);
  });

  it("changes only the three v37 function definitions by qualifying their helper calls", () => {
    const { source } = read(213);
    const historical = fs.readFileSync("src/lib/db/schema/sources.ts", "utf8");
    const names = [
      "omni_source_id_array_is_canonical",
      "omni_jsonb_safe_integer_value",
      "omni_evidence_locator_v1_is_allowlisted",
    ];
    expect([...source.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)]
      .map((match) => match[1])).toEqual(names);
    for (const name of names) {
      const original = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\([\\s\\S]*?\\$function\\$[\\s\\S]*?\\$function\\$`)
        .exec(historical)?.[0];
      const replacement = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$[\\s\\S]*?\\$function\\$`)
        .exec(source)?.[0];
      expect(original).toBeDefined();
      expect(replacement?.replaceAll("public.", "").replace(/\s+/g, " "))
        .toBe(original?.replace(/\s+/g, " "));
    }
    expect(source).not.toMatch(/ALTER FUNCTION|SET search_path|DROP FUNCTION|GRANT |REVOKE /);
    expect(source).toContain("procedure.proconfig IS NULL");
  });

  it("validates exactly the 43 v208 additions and the v209 refresh check", () => {
    const selected = targets(read(214).source);
    const historical = targets(read(208).source);
    const integration = fs.readFileSync("tests/integration/database.integration.test.ts", "utf8");
    const missing = integration.split("const oldRunnerMissingChecks: Record<string, string[]> = {")[1]
      .split("\n};")[0];
    const additions = [...missing.matchAll(/"(omni_\w+)"/g)].map((match) => match[1]);
    expect(additions).toHaveLength(43);
    expect(selected).toHaveLength(44);
    expect(selected.filter((item) => additions.includes(item.name)))
      .toEqual(historical.filter((item) => additions.includes(item.name)));
    expect(selected.map((item) => item.name).sort()).toEqual([
      ...additions, "omni_mobile_sessions_refresh_rotation_check",
    ].sort());
    expect(read(214).source).not.toMatch(/ADD CONSTRAINT|DROP CONSTRAINT|UPDATE public\.|DELETE FROM|INSERT INTO public\.(?!omni_schema_version)/);
    expect(read(214).source).toContain("IF NOT FOUND THEN");
    expect(read(214).source).toContain("IF NOT already_validated THEN");
  });

  it("keeps the count-only read-only preflight on exactly the same targets and predicates", () => {
    const preflight = fs.readFileSync("scripts/sql/schema-v214-preflight.sql", "utf8");
    const selected = targets(read(214).source);
    expect(targets(preflight)).toEqual(selected);
    expect(preflight).toContain("ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(preflight).toContain("SET LOCAL row_security = off");
    expect(preflight).not.toMatch(/ALTER TABLE|CREATE |INSERT INTO|UPDATE |DELETE FROM/);
    for (const { table, definition } of selected) {
      expect(preflight).toContain(
        `FROM public.${table}\nWHERE (${definition.slice(6).replaceAll("''", "'")}) IS FALSE`,
      );
    }
    expect([...preflight.matchAll(/count\(\*\) AS violating_rows/g)]).toHaveLength(44);
  });
});
