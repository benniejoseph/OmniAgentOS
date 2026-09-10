import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260910140000_knowledge_cognification_candidates.sql",
);

describe("knowledge cognition candidate migration", () => {
  it("installs an immutable actor-private review and projection boundary", async () => {
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain(
      "CREATE TABLE public.omni_knowledge_cognition_candidates",
    );
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain(
      "omni_actor_scope_v1_allows_canonical(\n    tenant_id, owner_actor_id",
    );
    expect(migration).toContain("Knowledge cognition evidence is immutable");
    expect(migration).toContain("Knowledge cognition history is immutable");
    expect(migration).toContain("status = 'pending_review'");
    expect(migration).toContain("status = 'confirmed'");
    expect(migration).toContain("status = 'dismissed'");
    expect(migration).toContain("memory_formation_reason IS DISTINCT FROM 'source_cognition'");
    expect(migration).toContain("'maintenance_promotion', 'source_cognition'");
    expect(migration).toContain("latest_version IS DISTINCT FROM 154");
    expect(migration).toContain(
      "'a8aa943ab72aed3c2d80a7d6abf46efb206b64ed476a6f674298a6e0eb1343f2'",
    );
    expect(migration).toContain(
      "'7be9cf9382966145ef45ed3dc5e7ce9ad4b9717592b9fc7200ad23bdf1776185'",
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:[A-Z, ]*\b)?(?:DELETE|TRUNCATE)\b/i,
    );
  });
});
