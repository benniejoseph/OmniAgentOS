import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureDelegationExecutionRuntimeV1 } from "@/lib/db/delegation-execution-schema";
import { ensureDelegationExecutionRlsCompositionRepairV1 } from "@/lib/db/delegation-execution-rls-schema";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260922120000_delegation_execution_runtime.sql",
);
const migration = readFileSync(migrationPath, "utf8");
const rlsRepairMigration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260923110000_delegation_execution_rls_composition_repair.sql",
), "utf8");
const databaseClient = readFileSync(resolve(
  process.cwd(),
  "src/lib/db/client.ts",
), "utf8");
const manifest = JSON.parse(readFileSync(resolve(
  process.cwd(),
  "schema-migrations.json",
), "utf8")) as Array<{ version: number; name: string; checksum: string }>;

describe("Delegation execution runtime v196 migration", () => {
  it("registers exactly after v195 in both migration paths", async () => {
    expect(manifest.find((entry) => entry.version === 196)).toEqual({
      version: 196,
      name: "delegation_execution_runtime_v1",
      checksum: "0113edbdab2a99f32d4e318c8407a5b66fb8fd7bcbbf839d4d199ded0d2ad6ac",
    });
    expect(migration).toContain("latest_version IS DISTINCT FROM 195");
    expect(migration).toContain(
      "196,\n  'delegation_execution_runtime_v1',\n  '0113edbdab2a99f32d4e318c8407a5b66fb8fd7bcbbf839d4d199ded0d2ad6ac'",
    );
    expect(databaseClient).toContain("...databaseSchemaMigrations[195]");
    expect(databaseClient).toContain("up: ensureDelegationExecutionRuntimeV1");

    const statements: string[] = [];
    await ensureDelegationExecutionRuntimeV1({
      query: async (text) => {
        statements.push(text);
        return [];
      },
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("CREATE TABLE public.omni_delegation_executions");
    expect(statements[0]).not.toContain("INSERT INTO public.omni_schema_version");
  });

  it("keeps identity immutable and lifecycle changes narrow", () => {
    for (const fragment of [
      "CREATE TABLE public.omni_delegation_budget_ledgers",
      "CREATE TABLE public.omni_delegation_executions",
      "child_run_id = execution_id",
      "contract->>'version' = 'delegation-execution-contract:2'",
      "OLD.state = 'completed_proposed' AND NEW.state IN ('verified', 'rejected'",
      "ALTER TABLE public.omni_delegation_executions FORCE ROW LEVEL SECURITY",
      "CREATE POLICY omni_delegation_executions_actor",
      "CREATE TRIGGER omni_delegation_execution_no_truncate",
      "budget_ledger_revision BIGINT NOT NULL",
    ]) {
      expect(migration).toContain(fragment);
    }
    expect(migration).not.toContain("GRANT DELETE ON public.omni_delegation");
    expect(migration).not.toContain("GRANT TRUNCATE ON public.omni_delegation");
  });

  it("does not let serving roles mutate immutable authority fields", () => {
    expect(migration).toContain(
      "GRANT UPDATE (reserved, lifecycle_revision, updated_at) ON public.omni_delegation_budget_ledgers TO omni_runtime",
    );
    expect(migration).toContain(
      "GRANT UPDATE (state, lifecycle_revision, result, result_sha256, verification, verification_sha256, failure_code, updated_at, terminal_at) ON public.omni_delegation_executions TO omni_runtime",
    );
    expect(migration).not.toContain(
      "GRANT UPDATE (contract",
    );
  });

  it("repairs policy composition without weakening actor isolation", async () => {
    expect(manifest.find((entry) => entry.version === 202)).toEqual({
      version: 202,
      name: "delegation_execution_rls_composition_repair_v1",
      checksum: "3d6b28bd2fdb00cc57360506baea3ef120a4ae13e0050be57ba6d266310a3d63",
    });
    expect(rlsRepairMigration).toContain("latest_version IS DISTINCT FROM 201");
    expect(rlsRepairMigration).toContain("AS PERMISSIVE FOR ALL TO PUBLIC");
    expect(rlsRepairMigration).toContain("AND NOT polpermissive");
    expect(rlsRepairMigration).toContain("omni_actor_scope_v1_allows(tenant_id, owner_actor_id)");
    expect(rlsRepairMigration).toContain("SELECT count(*)");
    expect(databaseClient).toContain('"omni_delegation_budget_ledgers"');
    expect(databaseClient).toContain('"omni_delegation_executions"');
    expect(databaseClient).toContain("...databaseSchemaMigrations[201]");
    expect(databaseClient).toContain(
      "up: ensureDelegationExecutionRlsCompositionRepairV1",
    );

    const statements: string[] = [];
    await ensureDelegationExecutionRlsCompositionRepairV1({
      query: async (text) => {
        statements.push(text);
        return [];
      },
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("CREATE POLICY omni_tenant_isolation");
    expect(statements[0]).not.toContain("INSERT INTO public.omni_schema_version");
  });
});
