import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  databaseSchemaMigrations,
  tenantRootPolicyTables,
} from "@/lib/db/client";

const migrationName = "generated_artifact_persistence_v1";
const migrationChecksum = createHash("sha256")
  .update(migrationName)
  .digest("hex");
const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260919150000_generated_artifact_persistence.sql",
  ),
  "utf8",
);
const databaseClient = fs.readFileSync(
  path.join(process.cwd(), "src/lib/db/client.ts"),
  "utf8",
);

describe("generated artifact persistence migration", () => {
  it("appends exact ordered migration v189", () => {
    expect(migrationChecksum).toBe(
      "4065c615c77bf4baf5921d5dcd468359ed8113bc49ba5291908bdfc3b9f36ebf",
    );
    expect(databaseSchemaMigrations.find((migration) => migration.version === 189)).toEqual({
      version: 189,
      name: migrationName,
      checksum: migrationChecksum,
    });
    expect(migration).toContain("latest_version IS DISTINCT FROM 188");
    expect(migration).toContain("'builtin_skill_catalog_v3'");
    expect(migration).toContain(
      "4c206314533b7812aff807d551f1b1514987582b64c21e1c17378ac0c592deb1",
    );
    expect(migration).toContain(
      "VALUES (\n  189,\n  'generated_artifact_persistence_v1'",
    );
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("installs actor-private heads, immutable versions, and mutation receipts", () => {
    for (const tableName of [
      "omni_generated_artifacts",
      "omni_generated_artifact_versions",
      "omni_generated_artifact_mutations",
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${tableName}`);
      expect(tenantRootPolicyTables).toContain(tableName);
    }
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("AS RESTRICTIVE FOR ALL TO PUBLIC");
    expect(migration).toContain("omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
    expect(migration).toContain("Generated artifact versions are immutable");
    expect(migration).toContain("Generated artifact mutation receipts are immutable");
    expect(migration).toContain(
      "UNIQUE (tenant_id, owner_actor_id, operation, idempotency_key_sha256)",
    );
  });

  it("binds structured specs, exact bytes, lineage, Google refs, and lifecycle", () => {
    for (const sql of [migration, databaseClient]) {
      expect(sql).toContain("spec_snapshot JSONB NOT NULL");
      expect(sql).toContain("spec_sha256 TEXT NOT NULL");
      expect(sql).toContain("content_sha256 TEXT");
      expect(sql).toContain("byte_count BIGINT");
      expect(sql).toContain("content_bytes BYTEA");
      expect(sql).toContain("lineage_refs TEXT[]");
      expect(sql).toContain("evidence_refs TEXT[]");
      expect(sql).toContain("google_resource_ref JSONB");
      expect(sql).toContain(
        "render_status IN ('queued', 'rendering', 'ready', 'failed')",
      );
      expect(sql).toContain(
        "source_kind IN ('capture_asset', 'capture_segment', 'generated_artifact')",
      );
      expect(sql).toContain(
        "(capture_asset|capture_segment|generated_artifact)",
      );
    }
  });
});
