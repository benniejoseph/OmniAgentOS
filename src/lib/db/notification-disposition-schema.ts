import "server-only";

import { readFile } from "node:fs/promises";

type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

const BODY_START = "-- Durable proactive notification policy records content-free dispositions.";
const BODY_END = "INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)";

/** Runtime form of ordered migration v200 for development schema convergence. */
export async function ensureNotificationDispositionRuntimeV1(sql: MigrationSql) {
  const migration = await readFile(new URL(
    "../../../supabase/migrations/20260922163000_notification_disposition_runtime.sql",
    import.meta.url,
  ), "utf8");
  const start = migration.indexOf(BODY_START);
  const end = migration.lastIndexOf(BODY_END);
  if (start < 0 || end <= start) {
    throw new Error("Notification disposition runtime migration markers are invalid.");
  }
  const body = migration.slice(start, end).trim();
  for (const required of [
    "CREATE TABLE public.omni_notification_dispositions",
    "CREATE TABLE public.omni_notification_digest_deliveries",
    "CREATE TABLE public.omni_notification_digest_watermarks",
    "omni_protect_notification_disposition_v1",
    "omni_protect_notification_digest_watermark_v1",
    "omni_mobile_push_deliveries_cause_kind_check_v3",
    "FORCE ROW LEVEL SECURITY",
  ]) {
    if (!body.includes(required)) {
      throw new Error("Notification disposition runtime schema is incomplete.");
    }
  }
  await sql.query(body);
}
