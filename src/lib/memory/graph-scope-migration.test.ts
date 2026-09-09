import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { databaseSchemaMigrations } from "@/lib/db/client";

describe("memory graph scope v2 migration", () => {
  it("extends the projection contract without weakening scoped access", async () => {
    const migration = await readFile(
      new URL(
        "../../../supabase/migrations/20260909203000_memory_graph_scope_v2.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(databaseSchemaMigrations.at(-1)).toEqual({
      version: 152,
      name: "memory_graph_scope_v2",
      checksum:
        "80fb478914e814d44034b303b3bcf39e4f99c7f66f0240f114fe23e704ab29ae",
    });
    expect(migration).toContain("omni_memory_graph_nodes_scope_v2_check");
    expect(migration).toContain("omni_memory_graph_edges_scope_v2_check");
    expect(migration).toContain("visibility = 'agent_private'");
    expect(migration).toContain(
      "visibility IN ('project_shared', 'workspace_shared')",
    );
    expect(migration).toContain("omni_user_private_memory_scope_v1_allows");
    expect(migration).toContain("omni_agent_private_memory_scope_v1_allows");
    expect(migration).toContain("omni_shared_memory_scope_v1_allows");
    expect(migration).toContain("omni_system_scope_enabled()");
    expect(migration).toContain("AS RESTRICTIVE");
    expect(migration).not.toMatch(/GRANT\s+(?:ALL|DELETE|TRUNCATE)\b/i);
  });
});
