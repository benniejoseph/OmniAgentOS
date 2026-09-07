import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260908013000_p10_9_customer_account_360.sql",
);

describe("P10.9 Customer Account 360 migration", () => {
  it("installs immutable account and fact history with restrictive workspace RLS", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("CREATE TABLE omni_customer_accounts");
    expect(sql).toContain("CREATE TABLE omni_customer_account_revisions");
    expect(sql).toContain("CREATE TABLE omni_customer_fact_revisions");
    expect(sql).toContain("omni_customer_account_revisions_immutable");
    expect(sql).toContain("omni_customer_fact_revisions_immutable");
    expect(sql).toContain("omni_customer_accounts_protected");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("AS RESTRICTIVE FOR SELECT");
    expect(sql).toContain("AS RESTRICTIVE FOR INSERT");
    expect(sql).toContain("customer_success.account.read");
    expect(sql).toContain("customer_success.account.manage");
    expect(sql).toContain("externalWriteState");
    expect(sql).toContain("'customer_account_360_v1'");
  });
});
