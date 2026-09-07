import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260908060000_p10_13_customer_success_workflows.sql",
);

describe("customer-success workflow migration", () => {
  it("installs immutable run receipts and a forced-RLS current projection", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("CREATE TABLE omni_customer_success_workflow_run_revisions");
    expect(sql).toContain("CREATE TABLE omni_customer_success_workflow_runs");
    expect(sql).toContain("omni_customer_success_workflow_run_revisions_immutable");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("AS RESTRICTIVE FOR SELECT");
    expect(sql).toContain("omni_customer_workspace_access_v1_allows");
    expect(sql).toContain("OLD.outcome_status IN ('completed', 'cancelled')");
    expect(sql).toContain("customer_success_workflows_v1");
    expect(sql).toContain("6ed4f5625107af151e49cf1fe094b9637af2053f5f1c85e31f6984cc1b4e7f38");
  });
});
