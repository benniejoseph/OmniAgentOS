import "server-only";

import { readFile } from "node:fs/promises";

type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

const BODY_START = "-- Canonical V2 delegation executions retain their complete authority envelope.";
const BODY_END = "INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)";

/**
 * Runtime form of ordered migration v196. The standalone Supabase migration
 * remains the canonical DDL; the development migrator executes the identical
 * body without writing its own schema marker.
 */
export async function ensureDelegationExecutionRuntimeV1(sql: MigrationSql) {
  const migration = await readFile(new URL(
    "../../../supabase/migrations/20260922120000_delegation_execution_runtime.sql",
    import.meta.url,
  ), "utf8");
  const start = migration.indexOf(BODY_START);
  const end = migration.lastIndexOf(BODY_END);
  if (start < 0 || end <= start) {
    throw new Error("Delegation execution runtime migration markers are invalid.");
  }
  const body = migration.slice(start, end).trim();
  for (const required of [
    "CREATE TABLE public.omni_delegation_budget_ledgers",
    "CREATE TABLE public.omni_delegation_executions",
    "omni_protect_delegation_budget_ledger_v1",
    "omni_protect_delegation_execution_v1",
    "FORCE ROW LEVEL SECURITY",
  ]) {
    if (!body.includes(required)) {
      throw new Error("Delegation execution runtime schema is incomplete.");
    }
  }
  await sql.query(body);
}
