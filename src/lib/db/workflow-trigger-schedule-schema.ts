import "server-only";

import { readFile } from "node:fs/promises";

type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

const BODY_START = "-- Schedule metadata extends the existing workflow-trigger runtime.";
const BODY_END = "INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)";

/**
 * Runtime form of ordered migration v197. The standalone Supabase migration
 * remains canonical; the development migrator executes its body without
 * writing a second schema-version marker.
 */
export async function ensureScheduledWorkflowTriggerShadowV1(sql: MigrationSql) {
  const migration = await readFile(new URL(
    "../../../supabase/migrations/20260922130000_scheduled_workflow_trigger_shadow.sql",
    import.meta.url,
  ), "utf8");
  const start = migration.indexOf(BODY_START);
  const end = migration.lastIndexOf(BODY_END);
  if (start < 0 || end <= start) {
    throw new Error("Scheduled workflow trigger migration markers are invalid.");
  }
  const body = migration.slice(start, end).trim();
  for (const required of [
    "ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'webhook'",
    "CREATE TABLE public.omni_workflow_schedule_shadow_events",
    "omni_protect_scheduled_workflow_trigger_v1",
    "shadow_next_due_at",
    "FORCE ROW LEVEL SECURITY",
  ]) {
    if (!body.includes(required)) {
      throw new Error("Scheduled workflow trigger shadow schema is incomplete.");
    }
  }
  await sql.query(body);
}
