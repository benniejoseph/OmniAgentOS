import "server-only";

import { readFile } from "node:fs/promises";

type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

const BODY_START = "-- A reviewed schedule is immutable.";
const BODY_END = "INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)";

/** Runtime form of ordered migration v198 for local development only. */
export async function ensureScheduledWorkflowReadOnlyCanaryV1(
  sql: MigrationSql,
) {
  const migration = await readFile(new URL(
    "../../../supabase/migrations/20260922143000_scheduled_workflow_read_only_canary.sql",
    import.meta.url,
  ), "utf8");
  const start = migration.indexOf(BODY_START);
  const end = migration.lastIndexOf(BODY_END);
  if (start < 0 || end <= start) {
    throw new Error("Scheduled workflow canary migration markers are invalid.");
  }
  const body = migration.slice(start, end).trim();
  for (const required of [
    "CREATE TABLE public.omni_workflow_schedule_occurrences",
    "CREATE TABLE public.omni_workflow_schedule_occurrence_receipts",
    "omni_workflow_schedule_occurrences_actor",
    "omni_workflow_schedule_occurrence_receipts_immutable",
    "replaces_trigger_id",
  ]) {
    if (!body.includes(required)) {
      throw new Error("Scheduled workflow read-only canary schema is incomplete.");
    }
  }
  await sql.query(body);
}
