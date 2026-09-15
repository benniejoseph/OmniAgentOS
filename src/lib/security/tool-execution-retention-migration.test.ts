import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { databaseSchemaMigrations } from "@/lib/db/client";

describe("tool execution retention redaction v2 migration", () => {
  it("scrubs pre-approval output without weakening execution identity", async () => {
    const migration = await readFile(
      new URL(
        "../../../supabase/migrations/20260915210000_tool_execution_retention_redaction_v2.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(databaseSchemaMigrations.at(-1)).toEqual({
      version: 175,
      name: "tool_execution_retention_redaction_v2",
      checksum: "300aff0f20a6d42ce84437c5ae8c45ac0c9e7fcd0f64b5b52fd5a291bd385e57",
    });
    expect(migration).toContain("latest_version IS DISTINCT FROM 174");
    expect(migration).toContain("OLD.status = 'approval_required'");
    expect(migration).toContain("is_expired_approval_redaction := COALESCE((");
    expect(migration).not.toContain("AND OLD.output IS NULL");
    expect(migration).toContain("AND NEW.output IS NULL");
    expect(migration).toContain("OLD.approvals");
    expect(migration).toContain("OLD.approved_by");
    expect(migration).toContain("OLD.approved_at");
    expect(migration).toContain("Governed tool execution identity is immutable");
  });
});
