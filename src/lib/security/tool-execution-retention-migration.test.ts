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

    expect(
      databaseSchemaMigrations.find((migration) => migration.version === 175),
    ).toEqual({
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

  it("keeps the embedded v1 and v2 redaction predicates null-safe and syntactically closed", async () => {
    const source = await readFile(
      new URL("../db/client.ts", import.meta.url),
      "utf8",
    );
    const v1Start = source.indexOf(
      "async function ensureToolExecutionRetentionRedactionV1",
    );
    const v2Start = source.indexOf(
      "async function ensureToolExecutionRetentionRedactionV2",
      v1Start,
    );
    const v2End = source.indexOf(
      "async function ensureActorScopedEventCorrelationIndex",
      v2Start,
    );

    expect(v1Start).toBeGreaterThan(0);
    expect(v2Start).toBeGreaterThan(v1Start);
    expect(v2End).toBeGreaterThan(v2Start);

    for (const migration of [
      source.slice(v1Start, v2Start),
      source.slice(v2Start, v2End),
    ]) {
      expect(
        migration.match(/is_expired_approval_redaction := COALESCE\(\(/g),
      ).toHaveLength(1);
      expect(migration.match(/\), FALSE\);/g)).toHaveLength(1);
      expect(migration).toContain("AND NOT is_expired_approval_redaction");
    }
  });
});
