import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const file = "20260928090000_schema_catalog_convergence.sql";
const source = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations", file),
  "utf8",
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
) as Array<{ version: number; name: string; checksum: string; file?: string }>;

describe("schema catalog convergence migration v208", () => {
  it("runs only on a database whose latest migration is the recorded v207", () => {
    const predecessor = manifest.find((migration) => migration.version === 207);

    expect(predecessor?.name).toBe("memory_forget_lineage_closure_v1");
    expect(source).toContain("IF latest_version IS DISTINCT FROM 207 OR (");
    expect(source).toContain(
      `WHERE version = 207\n      AND name = '${predecessor?.name}'\n`
        + `      AND checksum = '${predecessor?.checksum}'\n  ) <> 1 THEN\n`
        + "    RAISE EXCEPTION 'Schema catalog convergence predecessor is invalid'\n"
        + "      USING ERRCODE = '55000';",
    );
  });

  it("checks the definition of each constraint it renames or adds outside the loop", () => {
    const renamed = [
      ...source.matchAll(/\(\d+, '(omni_\w+)',\n +'omni_\w+',\n +'(omni_\w+)'\)/g),
    ].map(([, tableName, constraintName]) => `${tableName}.${constraintName}`);
    const checked = new Set(
      [...source.matchAll(/\('(omni_\w+)',\n +'(omni_\w+)',\n +'CHECK /g)]
        .map(([, tableName, constraintName]) => `${tableName}.${constraintName}`),
    );

    expect(renamed).toHaveLength(8);
    expect(checked.size).toBe(51);
    expect(
      [
        ...renamed,
        "omni_mobile_push_deliveries.omni_mobile_push_deliveries_deep_link_check",
      ].filter((constraint) => !checked.has(constraint)),
    ).toEqual([]);
  });

  it("restores the system scope function exactly as maintenance_system_scope_v1 defines it", () => {
    const maintenance = manifest.find(
      (migration) => migration.name === "maintenance_system_scope_v1",
    );
    const migrationsDirectory = path.join(process.cwd(), "supabase/migrations");
    const functionDefinition = (sql: string) =>
      /CREATE OR REPLACE FUNCTION public\.omni_system_scope_enabled\(\)\n[\s\S]*?\n\$function\$;/
        .exec(sql)?.[0];
    const maintenanceDefinition = functionDefinition(
      fs.readFileSync(path.join(migrationsDirectory, maintenance?.file ?? ""), "utf8"),
    );

    expect(maintenanceDefinition).toContain("AND NOT rolsuper");
    expect(functionDefinition(source)).toBe(maintenanceDefinition);
    // No other migration file redefines it in between.
    expect(
      fs.readdirSync(migrationsDirectory)
        .filter((name) =>
          name.endsWith(".sql")
          && fs.readFileSync(path.join(migrationsDirectory, name), "utf8")
            .includes("FUNCTION public.omni_system_scope_enabled()"))
        .sort(),
    ).toEqual([maintenance?.file, file]);
  });

  it("records itself as v208 from its own file", () => {
    expect(manifest.find((migration) => migration.version === 208)).toMatchObject({
      name: "schema_catalog_convergence_v1",
      file,
    });
    expect(source).toContain("VALUES (\n  208,\n  'schema_catalog_convergence_v1',");
    expect(source.trimEnd()).toMatch(/COMMIT;$/);
  });
});
