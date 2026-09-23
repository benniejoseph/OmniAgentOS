import "server-only";

import { readFile } from "node:fs/promises";

type MigrationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}>;

const BODY_START = "-- Google connector accounts are explicit, owner-scoped, and independently selectable.";
const BODY_END = "INSERT INTO public.omni_schema_version (version, name, checksum, applied_at)";

/** Runtime form of ordered migration v204 for development schema convergence. */
export async function ensureGoogleMultiAccountConnectionsV1(sql: MigrationSql) {
  const migration = await readFile(new URL(
    "../../../supabase/migrations/20260923143000_google_multi_account_connections.sql",
    import.meta.url,
  ), "utf8");
  const start = migration.indexOf(BODY_START);
  const end = migration.lastIndexOf(BODY_END);
  if (start < 0 || end <= start) {
    throw new Error("Google multi-account migration markers are invalid.");
  }
  const body = migration.slice(start, end).trim();
  for (const required of [
    "account_email TEXT",
    "connection_label TEXT",
    "connection_purpose TEXT",
    "omni_oauth_grants_actor_provider_purpose_key",
    "omni_oauth_grants_actor_provider_email_key",
  ]) {
    if (!body.includes(required)) {
      throw new Error("Google multi-account connection schema is incomplete.");
    }
  }
  await sql.query(body);
}
