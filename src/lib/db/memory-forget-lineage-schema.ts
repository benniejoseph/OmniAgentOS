import "server-only";

import { readFile } from "node:fs/promises";

type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

const BODY_START = "-- Forget computes one lineage closure over every visibility.";
const BODY_END = "INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)";

/** Runtime form of ordered migration v207 for local development convergence. */
export async function ensureMemoryForgetLineageClosureV1(sql: MigrationSql) {
  const migration = await readFile(new URL(
    "../../../supabase/migrations/20260926090000_memory_forget_lineage_closure.sql",
    import.meta.url,
  ), "utf8");
  const start = migration.indexOf(BODY_START);
  const end = migration.lastIndexOf(BODY_END);
  if (start < 0 || end <= start) {
    throw new Error("Memory forget lineage migration markers are invalid.");
  }
  const body = migration.slice(start, end).trim();
  for (const required of [
    "omni_memory_deletion_manifest_v1",
    "omni_apply_memory_deletion_receipt",
    "omni_memory_reference_shares_owner_v1",
    "omni_agent_private_memory_owner_forget_v1_allows",
    "omni.memory_deletion_lineage",
  ]) {
    if (!body.includes(required)) {
      throw new Error("Memory forget lineage runtime schema is incomplete.");
    }
  }
  await sql.query(body);
}
