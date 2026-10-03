import { readFile } from "node:fs/promises";
import {
  ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope,
} from "@/lib/db/client";
import type { SqlClient, SqlRow } from "@/lib/db/sql-types";
import type { CompanionChange } from "@/lib/companion/contracts";
import {
  CompanionPreferencesError, companionIdempotencyHash, companionMutationSchema, companionOwnerCoordinates,
  ownerConflict, prepareCompanionChange, storageInvalid, storedCompanionSchema,
  type CompanionMutation, type CompanionOwner, type CompanionOwnerCoordinates, type CompanionStoredChange,
  type CompanionThreadCheck, type StoredCompanion,
} from "@/lib/companion/state";
import { withJsonFileLock, writeJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

type Ledger = { schemaVersion: 1; preferences: unknown[]; mutations: unknown[] };
export type CompanionStore = {
  read: (owner: CompanionOwner) => Promise<StoredCompanion | undefined>;
  change: (owner: CompanionOwner, input: CompanionChange, idempotencyKey: string, threadCheck?: CompanionThreadCheck) => Promise<CompanionStoredChange>;
};

export const companionStore: CompanionStore = { read: readCompanionPreferences, change: changeCompanionPreferences };

export async function readCompanionPreferences(owner: CompanionOwner): Promise<StoredCompanion | undefined> {
  const coordinates = companionOwnerCoordinates(owner);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(coordinates.tenantId, coordinates.readableActorIds, async () =>
      readCurrentSql(getSql(), coordinates));
  }
  assertLocalStorage();
  return currentFromLedger(await readLedger(), coordinates);
}

export async function changeCompanionPreferences(
  owner: CompanionOwner,
  input: CompanionChange,
  idempotencyKey: string,
  threadCheck?: CompanionThreadCheck,
): Promise<CompanionStoredChange> {
  const coordinates = companionOwnerCoordinates(owner);
  const keyHash = companionIdempotencyHash(idempotencyKey);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(coordinates.tenantId, coordinates.readableActorIds, async () => {
      return await getSql().transaction(async (sql: SqlClient) => {
        // Lock every readable coordinate in stable order, including the initial insert.
        for (const actor of [...coordinates.readableActorIds].sort()) {
          const lock = JSON.stringify(["companion-preferences:1", coordinates.tenantId, actor]);
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
        }
        const current = await readCurrentSql(sql, coordinates);
        const receiptRows = await sql`
          SELECT * FROM omni_companion_preference_mutations
          WHERE tenant_id = ${coordinates.tenantId}
            AND (actor_id = ${coordinates.readableActorIds[0]} OR actor_id = ${coordinates.requestActorId})
            AND idempotency_sha256 = ${keyHash}
          LIMIT 2
        `;
        if (receiptRows.length > 1) throw ownerConflict();
        const existing = receiptRows[0] ? mutationFromRow(receiptRows[0], coordinates) : undefined;
        const result = prepareCompanionChange(coordinates, current, existing, input, idempotencyKey, threadCheck, new Date().toISOString());
        if (result.replayed) return result;
        const record = result.current;
        const receipt = result.receipt;
        const rows = current ? await sql`
          UPDATE omni_companion_preferences
          SET revision = ${record.revision}, intensity = ${record.preferences.intensity}, visible = ${record.preferences.visible},
            motion = ${record.preferences.motion}, default_destination = ${record.preferences.defaultDestination},
            preferred_thread_id = ${record.preferences.preferredThreadId}, updated_at = ${record.updatedAt}
          WHERE tenant_id = ${record.tenantId} AND actor_id = ${record.actorId}
            AND revision = ${input.expectedRevision}
          RETURNING *
        ` : await sql`
          INSERT INTO omni_companion_preferences (
            schema_version, tenant_id, actor_id, revision, intensity, visible, motion,
            default_destination, preferred_thread_id, created_at, updated_at
          ) VALUES (
            1, ${record.tenantId}, ${record.actorId}, ${record.revision}, ${record.preferences.intensity},
            ${record.preferences.visible}, ${record.preferences.motion}, ${record.preferences.defaultDestination},
            ${record.preferences.preferredThreadId}, ${record.createdAt}, ${record.updatedAt}
          )
          RETURNING *
        `;
        if (rows.length !== 1) throw new CompanionPreferencesError("Companion preferences changed. Reload before saving again.", 409, "companion_revision_conflict");
        const saved = preferenceFromRow(rows[0], coordinates);
        if (JSON.stringify(saved) !== JSON.stringify(record)) throw storageInvalid();
        await sql`
          INSERT INTO omni_companion_preference_mutations (
            schema_version, id, tenant_id, actor_id, idempotency_sha256, request_sha256,
            expected_revision, revision, preferences, saved_at
          ) VALUES (
            1, ${receipt.id}, ${receipt.tenantId}, ${receipt.actorId}, ${receipt.idempotencySha256}, ${receipt.requestSha256},
            ${receipt.expectedRevision}, ${receipt.revision}, ${receipt.preferences}::jsonb, ${receipt.savedAt}
          )
        `;
        return { ...result, current: saved };
      }) as CompanionStoredChange;
    });
  }
  assertLocalStorage();
  const file = ledgerPath();
  return withJsonFileLock(file, async () => {
    const ledger = await readLedger();
    const current = currentFromLedger(ledger, coordinates);
    const matches = ledger.mutations.filter((value) => scoped(value, coordinates) && value.idempotencySha256 === keyHash);
    if (matches.length > 1) throw ownerConflict();
    const existing = matches[0] ? parseMutation(matches[0]) : undefined;
    const result = prepareCompanionChange(coordinates, current, existing, input, idempotencyKey, threadCheck, new Date().toISOString());
    if (!result.replayed) {
      await writeJsonFile(file, {
        ...ledger,
        preferences: [...ledger.preferences.filter((value) => !scoped(value, coordinates)), result.current],
        mutations: [...ledger.mutations, result.receipt],
      } satisfies Ledger);
    }
    return result;
  });
}

async function readCurrentSql(sql: SqlClient, coordinates: CompanionOwnerCoordinates) {
  const rows = await sql`
    SELECT * FROM omni_companion_preferences
    WHERE tenant_id = ${coordinates.tenantId}
      AND (actor_id = ${coordinates.readableActorIds[0]} OR actor_id = ${coordinates.requestActorId})
    LIMIT 2
  `;
  if (rows.length > 1) throw ownerConflict();
  return rows[0] ? preferenceFromRow(rows[0], coordinates) : undefined;
}
function preferenceFromRow(row: SqlRow, coordinates: CompanionOwnerCoordinates) {
  const value = {
    schemaVersion: row.schema_version, tenantId: row.tenant_id, actorId: row.actor_id, revision: Number(row.revision),
    preferences: { intensity: row.intensity, visible: row.visible, motion: row.motion, defaultDestination: row.default_destination, preferredThreadId: row.preferred_thread_id },
    createdAt: instant(row.created_at), updatedAt: instant(row.updated_at),
  };
  if (!scoped(value, coordinates)) throw storageInvalid();
  return parsePreference(value);
}
function mutationFromRow(row: SqlRow, coordinates: CompanionOwnerCoordinates) {
  const value = {
    schemaVersion: row.schema_version, id: row.id, tenantId: row.tenant_id, actorId: row.actor_id,
    idempotencySha256: row.idempotency_sha256, requestSha256: row.request_sha256,
    expectedRevision: Number(row.expected_revision), revision: Number(row.revision),
    preferences: row.preferences, savedAt: instant(row.saved_at),
  };
  if (!scoped(value, coordinates)) throw storageInvalid();
  return parseMutation(value);
}
function currentFromLedger(ledger: Ledger, coordinates: CompanionOwnerCoordinates) {
  const rows = ledger.preferences.filter((value) => scoped(value, coordinates));
  if (rows.length > 1) throw ownerConflict();
  return rows[0] ? parsePreference(rows[0]) : undefined;
}
function parsePreference(value: unknown) {
  const parsed = storedCompanionSchema.safeParse(value);
  if (!parsed.success) throw storageInvalid();
  return parsed.data;
}
function parseMutation(value: unknown): CompanionMutation {
  const parsed = companionMutationSchema.safeParse(value);
  if (!parsed.success) throw storageInvalid();
  return parsed.data;
}
function scoped(value: unknown, coordinates: CompanionOwnerCoordinates): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).tenantId === coordinates.tenantId &&
    coordinates.readableActorIds.includes((value as Record<string, unknown>).actorId as string));
}
function instant(value: unknown) { return value instanceof Date ? value.toISOString() : value; }
function assertLocalStorage() {
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    throw new CompanionPreferencesError("Durable Companion preference storage is unavailable.", 503, "companion_storage_unavailable");
  }
}
function ledgerPath() { return getDataPath("companion-preferences.json"); }
async function readLedger(): Promise<Ledger> {
  let text: string;
  try { text = await readFile(ledgerPath(), "utf8"); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { schemaVersion: 1, preferences: [], mutations: [] };
    throw storageInvalid();
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw storageInvalid();
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1 || !Array.isArray(record.preferences) || !Array.isArray(record.mutations) || Object.keys(record).sort().join(",") !== "mutations,preferences,schemaVersion") throw storageInvalid();
    return record as Ledger;
  } catch { throw storageInvalid(); }
}
