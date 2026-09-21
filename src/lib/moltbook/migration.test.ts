import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureMoltbookAgentConnectionsV1 } from "@/lib/moltbook/schema";

const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260921120000_moltbook_agent_connections.sql",
), "utf8");
const databaseClient = readFileSync(resolve(
  process.cwd(),
  "src/lib/db/client.ts",
), "utf8");
const migrationManifest = JSON.parse(readFileSync(resolve(
  process.cwd(),
  "schema-migrations.json",
), "utf8")) as Array<{ version: number; name: string; checksum: string }>;

describe("Moltbook v190 migration", () => {
  it("links the connection to one exact tenant, actor, and custom Agent", () => {
    expect(migration).toContain("UNIQUE (tenant_id, actor_id, id)");
    expect(migration).toContain("FOREIGN KEY (tenant_id, owner_actor_id, agent_id)");
    expect(migration).toContain("REFERENCES omni_custom_agents (tenant_id, actor_id, id)");
    expect(migration).toContain("UNIQUE (tenant_id, owner_actor_id, agent_id)");
  });

  it("forces tenant-permissive plus actor-restrictive RLS", () => {
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(1);
    expect(migration).toContain("omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
    expect(migration).toContain("AS RESTRICTIVE FOR ALL TO PUBLIC");
    expect(migration).toContain("AS PERMISSIVE FOR ALL TO PUBLIC");
  });

  it("keeps activities and effect receipts append-only with least privilege", () => {
    expect(migration).toContain("omni_reject_moltbook_receipt_mutation_v1");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON omni_moltbook_activities");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON omni_moltbook_effect_receipts");
    expect(migration).toContain("GRANT SELECT, INSERT ON omni_moltbook_activities TO omni_runtime");
    expect(migration).not.toContain("GRANT DELETE ON omni_moltbook");
  });

  it("bounds JSON, protects the sealed credential, and fences lifecycle transitions", () => {
    expect(migration).toContain("pg_column_size(sealed_credentials) <= 131072");
    expect(migration).toContain("pg_column_size(rate_limit_projection) <= 4096");
    expect(migration).toContain("Moltbook credential transition is invalid");
    expect(migration).toContain("Moltbook connection lifecycle transition is invalid");
    expect(migration).toContain("'registering', 'pending_claim', 'claimed', 'paused', 'error', 'revoked'");
  });

  it("registers the same v190 identity with the ordered runtime migrator", () => {
    expect(migrationManifest.at(-1)).toEqual({
      version: 190,
      name: "moltbook_agent_connections_v1",
      checksum: "26386c7278e889ecafbb35d8bc35d17f4e519e0b0fb6da43b3e72295152c4147",
    });
    expect(migration).toContain("190,\n  'moltbook_agent_connections_v1',\n  '26386c7278e889ecafbb35d8bc35d17f4e519e0b0fb6da43b3e72295152c4147'");
    expect(databaseClient).toContain("up: ensureMoltbookAgentConnectionsV1");
    expect(databaseClient).toContain("...databaseSchemaMigrations[189]");
  });

  it("keeps the embedded v190 schema equivalent and idempotent", async () => {
    const statements: string[] = [];
    await ensureMoltbookAgentConnectionsV1({
      query: async (text) => {
        statements.push(text);
        return [];
      },
    });
    const runtimeSchema = statements.join("\n");
    for (const fragment of [
      "CREATE TABLE IF NOT EXISTS omni_moltbook_connections",
      "CREATE TABLE IF NOT EXISTS omni_moltbook_activities",
      "CREATE TABLE IF NOT EXISTS omni_moltbook_effect_receipts",
      "FOREIGN KEY (tenant_id, owner_actor_id, agent_id)",
      "Moltbook connection lifecycle transition is invalid",
      "Moltbook activities and effect receipts are immutable",
      "AS RESTRICTIVE FOR ALL TO PUBLIC",
      "GRANT SELECT, INSERT ON omni_moltbook_activities TO omni_runtime",
    ]) {
      expect(runtimeSchema).toContain(fragment);
    }
    expect(runtimeSchema).toContain("DROP POLICY IF EXISTS omni_tenant_isolation");
    expect(runtimeSchema).toContain("DROP TRIGGER IF EXISTS omni_moltbook_activities_immutable");
  });
});
