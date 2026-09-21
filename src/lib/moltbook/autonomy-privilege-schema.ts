import "server-only";

import { readFile } from "node:fs/promises";

type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

const BODY_START = "-- Serving roles must never receive direct access";
const BODY_END = "INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)";

/**
 * Runtime form of ordered migration v195. The standalone migration remains the
 * canonical DDL so the development migrator and Supabase release path cannot
 * diverge on the private identity boundary.
 */
export async function ensureMoltbookAutonomyPrivilegeRepairV1(
  sql: MigrationSql,
) {
  const migration = await readFile(new URL(
    "../../../supabase/migrations/20260921200000_moltbook_autonomy_privilege_repair.sql",
    import.meta.url,
  ), "utf8");
  const start = migration.indexOf(BODY_START);
  const end = migration.lastIndexOf(BODY_END);
  if (start < 0 || end <= start) {
    throw new Error("Moltbook autonomy privilege-repair migration markers are invalid.");
  }
  const body = migration.slice(start, end).trim();
  if (
    !body.includes("omni_resolve_moltbook_owner_membership_v1") ||
    !body.includes("omni_validate_moltbook_authority_version_v1") ||
    !body.includes("omni_validate_moltbook_enrollment_v1")
  ) {
    throw new Error("Moltbook autonomy privilege-repair runtime schema is incomplete.");
  }
  await sql.query(body);
}
