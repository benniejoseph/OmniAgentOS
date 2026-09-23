import "server-only";

import { readFile } from "node:fs/promises";

type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

const BODY_START = "-- Repair the V2 delegation policy composition";
const BODY_END = "INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)";

/**
 * Runtime form of ordered migration v202. Production request traffic only
 * verifies this marker; the dedicated migration job executes the same body.
 */
export async function ensureDelegationExecutionRlsCompositionRepairV1(
  sql: MigrationSql,
) {
  const migration = await readFile(new URL(
    "../../../supabase/migrations/20260923110000_delegation_execution_rls_composition_repair.sql",
    import.meta.url,
  ), "utf8");
  const start = migration.indexOf(BODY_START);
  const end = migration.lastIndexOf(BODY_END);
  if (start < 0 || end <= start) {
    throw new Error("Delegation execution RLS repair migration markers are invalid.");
  }
  const body = migration.slice(start, end).trim();
  for (const required of [
    "CREATE POLICY omni_tenant_isolation",
    "AS PERMISSIVE FOR ALL TO PUBLIC",
    "omni_tenant_visible(tenant_id)",
    "'omni_delegation_budget_ledgers'",
    "'omni_delegation_executions'",
    "AND NOT polpermissive",
    "FORCE ROW LEVEL SECURITY",
  ]) {
    if (!body.includes(required)) {
      throw new Error("Delegation execution RLS repair schema is incomplete.");
    }
  }
  await sql.query(body);
}
