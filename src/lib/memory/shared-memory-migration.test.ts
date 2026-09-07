import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260907233000_p10_4_workspace_shared_memory.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("P10.4 workspace shared-memory migration", () => {
  it("admits only explicit project and workspace bindings", () => {
    expect(migration).toContain("omni_memories_scope_v2_check");
    expect(migration).toContain("visibility = 'project_shared'");
    expect(migration).toContain("visibility = 'workspace_shared'");
    expect(migration).toContain("owner_agent_id IS NULL");
    expect(migration).toContain("mission_id IS NULL");
  });

  it("requires membership and an exact agent context grant", () => {
    expect(migration).toContain("omni_tenant_workspace_memberships");
    expect(migration).toContain("omni_work_project_memberships");
    expect(migration).toContain("omni_tenant_execution_principals");
    expect(migration).toContain("omni_tenant_memory_access_grants");
    expect(migration).toContain("row_memory_id = ANY(grant_record.resource_ids)");
    expect(migration).toContain("grant_record.grant_kind = 'context'");
  });

  it("preserves private isolation and records ordered migration 130", () => {
    expect(migration).toContain("omni_user_private_memory_scope_v1_allows");
    expect(migration).toContain("omni_agent_private_memory_scope_v1_allows");
    expect(migration).toContain("version = 129");
    expect(migration).toContain("130,");
    expect(migration).toContain("workspace_shared_memory_v1");
  });
});
