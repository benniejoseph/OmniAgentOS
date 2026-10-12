import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSqlMigrationFile, sqlMigrationFileDigest } from "@/lib/db/sql-migration-files";
const file = "20261013090000_responsibility_work_item_followthrough.sql";
const source = fs.readFileSync(`supabase/migrations/${file}`, "utf8");
describe("Work-item follow-through migration", () => {
  it("replaces only existing guards and pins its predecessor and normalized digest", () => {
    const ledger = parseSqlMigrationFile(file, source).ledger;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ version: 252, name: "responsibility_work_item_followthrough_v1" });
    expect(sqlMigrationFileDigest(source, [ledger[0].checksum])).toBe(ledger[0].checksum);
    expect(source).toContain("IS DISTINCT FROM 251");
    expect(source).toContain("CREATE OR REPLACE FUNCTION public.omni_protect_responsibility_runtime_head_v1()");
    expect(source).toContain("CREATE OR REPLACE FUNCTION public.omni_protect_responsibility_notification_head_v1()");
    expect(source).not.toMatch(/CREATE TABLE|CREATE POLICY|GRANT |DROP /);
  });
  it("retains immutable budgets and distinct closed lane bindings including notification source identity", () => {
    expect(source).toContain("config->>'pilot' = 'native_meeting_metadata_v1' AND config->'tool'->>'id' = 'app.meetings.show'");
    expect(source).toContain("config->>'pilot' = 'canonical_work_item_followthrough_v1' AND config->'tool'->>'id' = 'app.work_items.show'");
    expect(source).toContain("config->'stops' = '[\"expiry\"]'::JSONB");
    expect(source).toContain("draft->'draft'->'work' = config->'tool'->'input'");
    expect(source).toContain("config->'source' = runtime->'configuration'->'source'");
    expect(source).toContain("config IS DISTINCT FROM OLD.snapshot->'configuration'");
    expect(source).toContain("Responsibility used budget cannot reset");
  });
});
