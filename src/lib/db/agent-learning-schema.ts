import "server-only";

import { readFile } from "node:fs/promises";

type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

const BODY_START = "-- Daily learning is a content-free evidence projection.";
const BODY_END = "INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)";

/** Runtime form of ordered migration v203 for development schema convergence. */
export async function ensureAgentDailyLearningV1(sql: MigrationSql) {
  const migration = await readFile(new URL(
    "../../../supabase/migrations/20260923130000_agent_daily_learning.sql",
    import.meta.url,
  ), "utf8");
  const start = migration.indexOf(BODY_START);
  const end = migration.lastIndexOf(BODY_END);
  if (start < 0 || end <= start) {
    throw new Error("Agent daily learning migration markers are invalid.");
  }
  const body = migration.slice(start, end).trim();
  for (const required of [
    "CREATE TABLE public.omni_agent_learning_observations",
    "CREATE TABLE public.omni_agent_learning_cycles",
    "omni_reject_agent_learning_change_v1",
    "model_invoked BOOLEAN NOT NULL DEFAULT FALSE",
    "adaptation_activated BOOLEAN NOT NULL DEFAULT FALSE",
    "FORCE ROW LEVEL SECURITY",
  ]) {
    if (!body.includes(required)) {
      throw new Error("Agent daily learning schema is incomplete.");
    }
  }
  await sql.query(body);
}
