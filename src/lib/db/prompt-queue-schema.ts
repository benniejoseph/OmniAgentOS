import "server-only";

import { readFile } from "node:fs/promises";

type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

const BODY_START = "-- Actor-private queued command text is sealed at rest.";
const BODY_END = "INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)";
const CONTEXT_BODY_START = "-- Exact references are sealed separately from the prompt.";

/** Runtime form of ordered migration v201 for local development convergence. */
export async function ensurePromptQueueRuntimeV1(sql: MigrationSql) {
  const migration = await readFile(new URL(
    "../../../supabase/migrations/20260922170000_prompt_queue_runtime.sql",
    import.meta.url,
  ), "utf8");
  const start = migration.indexOf(BODY_START);
  const end = migration.lastIndexOf(BODY_END);
  if (start < 0 || end <= start) {
    throw new Error("Prompt queue runtime migration markers are invalid.");
  }
  const body = migration.slice(start, end).trim();
  for (const required of [
    "CREATE TABLE public.omni_prompt_queue_items",
    "omni_protect_prompt_queue_item_v1",
    "queue_grants_authority BOOLEAN NOT NULL DEFAULT FALSE",
    "FORCE ROW LEVEL SECURITY",
  ]) {
    if (!body.includes(required)) {
      throw new Error("Prompt queue runtime schema is incomplete.");
    }
  }
  await sql.query(body);
}

/** Runtime form of ordered migration v206 for local development convergence. */
export async function ensurePromptQueueContextPinsV1(sql: MigrationSql) {
  const migration = await readFile(new URL(
    "../../../supabase/migrations/20260924130000_prompt_queue_context_pins.sql",
    import.meta.url,
  ), "utf8");
  const start = migration.indexOf(CONTEXT_BODY_START);
  const end = migration.lastIndexOf(BODY_END);
  if (start < 0 || end <= start) {
    throw new Error("Prompt queue context migration markers are invalid.");
  }
  const body = migration.slice(start, end).trim();
  for (const required of [
    "ADD COLUMN sealed_context_references JSONB",
    "context_selection_sha256 TEXT",
    "omni_prompt_queue_context_pin_valid",
    "CREATE OR REPLACE FUNCTION public.omni_protect_prompt_queue_item_v1()",
  ]) {
    if (!body.includes(required)) {
      throw new Error("Prompt queue context runtime schema is incomplete.");
    }
  }
  await sql.query(body);
}
