import "server-only";

import { readFile } from "node:fs/promises";

type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

const BODY_START = "-- The original nine-tool connection remains valid.";
const BODY_END = "INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)";

/**
 * Runtime form of ordered migration v194. The SQL migration is the canonical
 * DDL source, so development/runtime migration cannot silently drift from the
 * production Supabase path. The ordered migrator owns the outer transaction,
 * predecessor check, and schema-version receipt.
 */
export async function ensureMoltbookAutonomyV1(sql: MigrationSql) {
  const migration = await readFile(new URL(
    "../../../supabase/migrations/20260921170000_moltbook_autonomy.sql",
    import.meta.url,
  ), "utf8");
  const start = migration.indexOf(BODY_START);
  const end = migration.lastIndexOf(BODY_END);
  if (start < 0 || end <= start) {
    throw new Error("Moltbook autonomy migration body markers are invalid.");
  }
  const body = migration.slice(start, end).trim();
  if (
    !body.includes("CREATE TABLE omni_moltbook_autonomy_enrollments") ||
    !body.includes("CREATE TABLE omni_moltbook_autonomy_action_claims") ||
    !body.includes("omni_moltbook_agent_boundary_is_exact_v1")
  ) {
    throw new Error("Moltbook autonomy runtime schema body is incomplete.");
  }
  await sql.query(body);
}
