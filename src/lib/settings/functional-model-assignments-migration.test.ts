import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("P11.8 functional model assignment migration", () => {
  it("invalidates legacy routes and installs versioned runtime receipts", async () => {
    const sql = await readFile(path.join(
      process.cwd(),
      "supabase/migrations/20260908080000_p11_8_functional_model_assignments.sql",
    ), "utf8");

    expect(sql).toContain("version = 142");
    expect(sql).toContain("SET scope = 'planner'");
    expect(sql).toContain("contract_version = 'legacy'");
    expect(sql).toContain("runtime_readiness = 'configuration_only'");
    expect(sql).toContain("'p11.8-model-assignment:1'");
    expect(sql).toContain("assignment_revision > 0");
    expect(sql).toContain("assignment_configuration_sha256");
    expect(sql).toContain("omni_ai_usage_assignment_receipt_idx");
    expect(sql).toContain("143,");
    expect(sql).toContain("'functional_model_assignments_v1'");
  });
});
