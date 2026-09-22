import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureDelegationExecutionRuntimeV1 } from "@/lib/db/delegation-execution-schema";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260922120000_delegation_execution_runtime.sql",
);
const migration = readFileSync(migrationPath, "utf8");
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
});
