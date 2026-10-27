import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSqlMigrationFile, readSqlMigrationFile } from "./sql-migration-files";

const file = "20261028090000_app_builder_verification_profiles.sql";
const source = fs.readFileSync(path.join(process.cwd(), "supabase/migrations", file), "utf8");
const prior = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260914170000_app_builder_verification.sql"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8")) as Array<{ version: number; name: string; checksum: string; file?: string; sha256?: string }>;

describe("App Builder verification profiles migration266", () => {
  it("pins the unchanged265 predecessor and verifies its own executable bytes", async () => {
    const predecessor = manifest.find(row => row.version === 265)!;
    const entry = manifest.find(row => row.version === 266)!;
    expect(source).toContain("latest_version IS DISTINCT FROM 265");
    expect(source).toContain(`name = '${predecessor.name}'`);
    expect(source).toContain(`checksum = '${predecessor.checksum}'`);
    expect(entry).toMatchObject({ name: "app_builder_verification_profiles_v1", file });
    const parsed = await readSqlMigrationFile({ file, sha256: entry.sha256!, migrations: [{ version: entry.version, name: entry.name, checksum: entry.checksum }] });
    expect(parsed.ledger).toEqual([{ version: 266, name: entry.name, checksum: entry.checksum }]);
  });
  it("changes only the checks-profile predicate and preserves every surrounding row constraint", () => {
    const rowCheck = (text: string) => text.slice(text.indexOf("CONSTRAINT omni_app_builder_verifications_row_check"))
      .split("CHECK (COALESCE(")[1].split(", FALSE))")[0].trim().replace(/\s+/g, " ");
    const original = rowCheck(prior).replace("AND jsonb_typeof(checks) = 'array' AND jsonb_array_length(checks) = 2 AND pg_column_size(checks) <= 16384", "AND CHECKS_PROFILE");
    const replacement = rowCheck(source).replace(/AND CASE WHEN jsonb_typeof\(checks\) = 'array' THEN .* ELSE FALSE END AND pg_column_size\(checks\) <= 16384/, "AND CHECKS_PROFILE");
    expect(replacement).toBe(original);
    expect(source).not.toContain("NOT VALID");
    const changes = parseSqlMigrationFile(file, source).statements.filter(statement => /^(?:ALTER|CREATE|DROP|UPDATE|DELETE|GRANT|REVOKE)\b/.test(statement));
    expect(changes.every(statement => statement.startsWith("ALTER TABLE public.omni_app_builder_verifications"))).toBe(true);
    expect(source.match(/ALTER TABLE public\.omni_app_builder_verifications/g)).toHaveLength(2);
    expect(source).not.toMatch(/CREATE (?:FUNCTION|POLICY|TRIGGER)|(?:UPDATE|DELETE FROM|GRANT|REVOKE) public\./);
  });
});
