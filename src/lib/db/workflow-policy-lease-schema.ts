import "server-only";

import { readFile } from "node:fs/promises";

type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

const BODY_START = "-- PolicyLeaseV1 is a single-use effect fence.";
const BODY_END = "INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)";

/** Runtime form of ordered migration v199 for local development only. */
export async function ensureScheduledWorkflowPolicyLeaseV1(
  sql: MigrationSql,
) {
  const migration = await readFile(new URL(
    "../../../supabase/migrations/20260922160000_scheduled_workflow_policy_lease.sql",
    import.meta.url,
  ), "utf8");
  const start = migration.indexOf(BODY_START);
  const end = migration.lastIndexOf(BODY_END);
  if (start < 0 || end <= start) {
    throw new Error("Scheduled workflow policy-lease migration markers are invalid.");
  }
  const body = migration.slice(start, end).trim();
  for (const required of [
    "CREATE TABLE public.omni_policy_leases",
    "CREATE TABLE public.omni_policy_lease_consumptions",
    "omni_policy_leases_actor",
    "omni_policy_lease_consumptions_immutable",
    "expires_at <= issued_at + INTERVAL '15 minutes'",
  ]) {
    if (!body.includes(required)) {
      throw new Error("Scheduled workflow policy-lease schema is incomplete.");
    }
  }
  await sql.query(body);
}
