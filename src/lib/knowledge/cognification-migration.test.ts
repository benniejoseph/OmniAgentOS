import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260910140000_knowledge_cognification_candidates.sql",
);
const memoryPolicyPath = path.join(
  process.cwd(),
  "supabase/migrations/20260905234500_memory_access_scope_initplan_policies.sql",
);
const bootstrapPath = path.join(process.cwd(), "src/lib/db/client.ts");
const retentionPath = path.join(process.cwd(), "src/lib/security/retention.ts");

describe("knowledge cognition candidate migration", () => {
  it("installs an immutable actor-private review and projection boundary", async () => {
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain(
      "CREATE TABLE public.omni_knowledge_cognition_candidates",
    );
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain(
      "omni_actor_scope_v1_allows(tenant_id, owner_actor_id)",
    );
    expect(migration).toContain(
      "omni_actor_scope_v1_allows_canonical(\n    tenant_id, owner_actor_id",
    );
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("Knowledge cognition actor scope is invalid");
    expect(migration).toContain("FOR SHARE OF item");
    expect(migration).toContain("retention_expires_at TIMESTAMPTZ");
    expect(migration).toContain("all_evidence.retention_expires_at");
    expect(migration).toContain(
      "selected_evidence.evidence_count =",
    );
    expect(migration).toContain(
      "all_evidence.evidence_count = document.chunk_count",
    );
    expect(migration).toContain(
      "source_retention_expires_at IS DISTINCT FROM",
    );
    expect(migration).toContain(
      "omni_purge_expired_knowledge_cognition_candidates",
    );
    expect(migration).toContain(
      "omni_retire_knowledge_cognition_memories_v1",
    );
    expect(migration).toContain(
      "public.omni_current_memory_access_scope_v1() IS NOT NULL",
    );
    expect(migration).toContain(
      "identifier.actor_identifier = requested_source_owner_actor_id",
    );
    expect(migration).toContain("memory.access_contract_version = 1");
    expect(migration).toContain(
      "candidate.document_id = ANY(requested_document_ids)",
    );
    expect(migration).toContain(
      "DELETE FROM public.omni_memory_graph_edges",
    );
    expect(migration).toContain(
      "IS NOT DISTINCT FROM candidate.retention_expires_at",
    );
    expect(migration).toContain("ON UPDATE RESTRICT ON DELETE CASCADE");
    expect(migration).toContain("Knowledge cognition evidence is immutable");
    expect(migration).toContain("Knowledge cognition history is immutable");
    expect(migration).toContain("status = 'pending_review'");
    expect(migration).toContain("status = 'confirmed'");
    expect(migration).toContain("status = 'dismissed'");
    expect(migration).toContain("memory.formation_reason = 'source_cognition'");
    expect(migration).toContain("memory.source = 'cognify-reviewed:' || NEW.id");
    expect(migration).toContain("'agent_shared_artifact'");
    expect(migration).toContain("'maintenance_promotion', 'source_cognition'");
    expect(migration).toContain("latest_version IS DISTINCT FROM 154");
    expect(migration).toContain(
      "'a8aa943ab72aed3c2d80a7d6abf46efb206b64ed476a6f674298a6e0eb1343f2'",
    );
    expect(migration).toContain(
      "'c14f3308088df1ce4eb94f7208580b91bc574efe7479bf2832d2f2ba853cac1e'",
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:[A-Z, ]*\b)?(?:DELETE|TRUNCATE)\b/i,
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT,\s*)?INSERT[^;]*TO\s+omni_maintenance/i,
    );
  });

  it("uses a bounded definer seam because ordinary memory scope cannot serve lifecycle cleanup", async () => {
    const [migration, memoryPolicy, bootstrap, retention] = await Promise.all([
      readFile(migrationPath, "utf8"),
      readFile(memoryPolicyPath, "utf8"),
      readFile(bootstrapPath, "utf8"),
      readFile(retentionPath, "utf8"),
    ]);

    expect(memoryPolicy).toContain(
      "(access_scope ->> 'executingPrincipalType') = 'user'",
    );
    expect(memoryPolicy).toContain(
      "access_contract_version = 0\n          AND (SELECT omni_current_memory_access_scope_v1()) IS NULL",
    );
    expect(bootstrap).toContain(
      "omni_retire_knowledge_cognition_memories_v1",
    );
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
    expect(retention).toContain("retireEntityMemoryLineage({");
    expect(retention).toContain("formation_reason !== \"source_cognition\"");
    expect(retention).toContain("queueTemporalRelationProjection({");
  });
});
