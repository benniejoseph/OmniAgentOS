import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSqlMigrationFile, sqlMigrationFileDigest } from "@/lib/db/sql-migration-files";
const file = "20261014100000_project_task_commitments.sql";
const source = fs.readFileSync(`supabase/migrations/${file}`, "utf8");
describe("structured project commitments migration", () => {
  it("adds nullable fields after the exact prior release without rewriting records or authority", () => {
    const ledger = parseSqlMigrationFile(file, source).ledger;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ version: 256, name: "project_task_commitments_v1" });
    expect(sqlMigrationFileDigest(source, [ledger[0].checksum])).toBe(ledger[0].checksum);
    expect(source).toContain("IS DISTINCT FROM 255");
    expect(source).toContain("ADD COLUMN due_date DATE");
    expect(source).toContain("due_at IS NULL");
    expect(source).not.toMatch(/UPDATE public\.|UPDATE omni_|CREATE TABLE|CREATE POLICY|GRANT |DROP |SET DEFAULT/);
  });
});
