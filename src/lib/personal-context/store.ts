import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { companionOwnerCoordinates, type CompanionOwner, type CompanionOwnerCoordinates } from "@/lib/companion/state";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import type { SqlClient, SqlRow } from "@/lib/db/sql-types";
import { withJsonFileLock, writeJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import {
  EMPTY_PERSONAL_PROFILE, PERSONAL_PROFILE_CONTRACT, PERSONAL_PROFILE_FIELDS, PERSONAL_PROFILE_SOURCE_LABELS,
  personalProfileChangeSchema, personalProfileFieldSourcesSchema, personalProfilePatchSchema, personalProfileSchema,
  type PersonalProfileChange, type PersonalProfileFieldSources, type PersonalProfilePatch, type PersonalProfileResponse,
} from "./contracts";

export class PersonalProfileError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 409 | 503, readonly code: string) {
    super(message); this.name = "PersonalProfileError";
  }
}
const instant = z.string().datetime();
const storedSchema = z.object({
  schemaVersion: z.literal(1), tenantId: z.string().min(1).max(240), actorId: z.string().min(1).max(320),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), enabled: z.boolean(),
  profile: personalProfileSchema, fieldSources: personalProfileFieldSourcesSchema,
  createdAt: instant, updatedAt: instant,
}).strict().refine(value => value.createdAt <= value.updatedAt && PERSONAL_PROFILE_FIELDS.every(key =>
  Boolean(value.profile[key]) === Boolean(value.fieldSources[key]) &&
  (!value.fieldSources[key] || value.fieldSources[key]!.updatedAt <= value.updatedAt)));
type StoredProfile = z.infer<typeof storedSchema>;
const mutationSchema = z.object({
  tenantId: z.string(), actorId: z.string(), keySha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(), savedAt: instant,
}).strict();
type Mutation = z.infer<typeof mutationSchema>;
type Ledger = { schemaVersion: 1; profiles: unknown[]; mutations: unknown[] };
const unavailable = () => new PersonalProfileError("About me is temporarily unavailable. Please try again.", 503, "personal_profile_unavailable");
const conflict = () => new PersonalProfileError("About me changed on another device. Reload before saving again.", 409, "personal_profile_revision_conflict");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function readPersonalProfile(owner: CompanionOwner): Promise<PersonalProfileResponse> {
  const coordinates = companionOwnerCoordinates(owner);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(coordinates.tenantId, coordinates.readableActorIds,
      async () => response(await readSql(getSql(), coordinates)));
  }
  assertLocal();
  return response(current(await readLedger(), coordinates));
}

export async function changePersonalProfile(owner: CompanionOwner, change: PersonalProfileChange, key: string): Promise<PersonalProfileResponse> {
  const parsed = personalProfileChangeSchema.safeParse(change);
  if (!parsed.success) throw new PersonalProfileError("Check the About me fields and try again.", 400, "personal_profile_invalid");
  return mutatePersonalProfile(owner, key, hash(parsed.data), () => parsed.data);
}

export async function patchPersonalProfile(owner: CompanionOwner, change: PersonalProfilePatch, key: string): Promise<PersonalProfileResponse> {
  const parsed = personalProfilePatchSchema.safeParse(change);
  if (!parsed.success) throw new PersonalProfileError("Check the About me fields and try again.", 400, "personal_profile_invalid");
  const patch = parsed.data;
  // Hash the original patch, before reading saved fields. A replay after a later
  // edit returns the current profile without resurrecting an earlier value.
  return mutatePersonalProfile(owner, key, hash(["personal-profile-patch:1", patch]), prior => ({
    expectedRevision: patch.expectedRevision,
    enabled: patch.enabled ?? prior?.enabled ?? false,
    profile: personalProfileSchema.parse({ ...EMPTY_PERSONAL_PROFILE, ...prior?.profile, ...patch.profile }),
    source: "conversation",
  }));
}

async function mutatePersonalProfile(owner: CompanionOwner, key: string, requestSha256: string,
  resolveChange: (prior: StoredProfile | undefined) => PersonalProfileChange): Promise<PersonalProfileResponse> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(key)) {
    throw new PersonalProfileError("A save identifier is required.", 400, "personal_profile_idempotency_invalid");
  }
  const coordinates = companionOwnerCoordinates(owner);
  const keySha256 = hash(["personal-profile-save:1", key]);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseActorScope(coordinates.tenantId, coordinates.readableActorIds, async () =>
      getSql().transaction(async (sql: SqlClient) => {
        for (const actorId of [...new Set(coordinates.readableActorIds)].sort()) {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["personal-profile:1", coordinates.tenantId, actorId])}, 0))`;
        }
        const prior = await readSql(sql, coordinates);
        const rows = await sql`SELECT * FROM omni_personal_profile_mutations
          WHERE tenant_id = ${coordinates.tenantId}
            AND (actor_id = ${coordinates.readableActorIds[0]} OR actor_id = ${coordinates.requestActorId})
            AND idempotency_sha256 = ${keySha256} LIMIT 2`;
        if (rows.length > 1) throw unavailable();
        const receipt = rows[0] ? parseMutationRow(rows[0], coordinates) : undefined;
        if (replayed(prior, receipt, requestSha256)) return response(prior);
        const input = resolveChange(prior);
        const next = prepare(coordinates, prior, input);
        const saved = prior ? await sql`UPDATE omni_personal_profiles
          SET revision = ${next.revision}, enabled = ${next.enabled}, profile = ${next.profile}::jsonb,
            field_sources = ${next.fieldSources}::jsonb, updated_at = ${next.updatedAt}
          WHERE tenant_id = ${next.tenantId} AND actor_id = ${next.actorId} AND revision = ${input.expectedRevision}
          RETURNING *` : await sql`INSERT INTO omni_personal_profiles
            (schema_version, tenant_id, actor_id, revision, enabled, profile, field_sources, created_at, updated_at)
          VALUES (1, ${next.tenantId}, ${next.actorId}, ${next.revision}, ${next.enabled}, ${next.profile}::jsonb,
            ${next.fieldSources}::jsonb, ${next.createdAt}, ${next.updatedAt}) RETURNING *`;
        if (saved.length !== 1) throw conflict();
        const confirmed = parseRow(saved[0], coordinates);
        await sql`INSERT INTO omni_personal_profile_mutations
          (tenant_id, actor_id, idempotency_sha256, request_sha256, revision, saved_at)
          VALUES (${confirmed.tenantId}, ${confirmed.actorId}, ${keySha256}, ${requestSha256}, ${confirmed.revision}, ${confirmed.updatedAt})`;
        return response(confirmed);
      }) as Promise<PersonalProfileResponse>);
  }
  assertLocal();
  return withJsonFileLock(ledgerPath(), async () => {
    const ledger = await readLedger();
    const prior = current(ledger, coordinates);
    const matches = ledger.mutations.filter(value => scoped(value, coordinates) && value.keySha256 === keySha256);
    if (matches.length > 1) throw unavailable();
    const receipt = matches[0] ? mutationSchema.parse(matches[0]) : undefined;
    if (replayed(prior, receipt, requestSha256)) return response(prior);
    const input = resolveChange(prior);
    const next = prepare(coordinates, prior, input);
    const mutation: Mutation = { tenantId: next.tenantId, actorId: next.actorId, keySha256, requestSha256, revision: next.revision, savedAt: next.updatedAt };
    await writeJsonFile(ledgerPath(), { schemaVersion: 1,
      profiles: [...ledger.profiles.filter(value => !scoped(value, coordinates)), next],
      mutations: [...ledger.mutations, mutation],
    } satisfies Ledger);
    return response(next);
  });
}

function prepare(coordinates: CompanionOwnerCoordinates, prior: StoredProfile | undefined, input: PersonalProfileChange): StoredProfile {
  if ((prior?.revision ?? 0) !== input.expectedRevision) throw conflict();
  const now = new Date().toISOString();
  const fieldSources: PersonalProfileFieldSources = {};
  for (const key of PERSONAL_PROFILE_FIELDS) {
    if (!input.profile[key]) continue;
    fieldSources[key] = prior?.profile[key] === input.profile[key] && prior.fieldSources[key]
      ? prior.fieldSources[key]
      : { source: input.source, label: PERSONAL_PROFILE_SOURCE_LABELS[input.source], updatedAt: now };
  }
  return storedSchema.parse({ schemaVersion: 1, tenantId: coordinates.tenantId,
    actorId: prior?.actorId ?? coordinates.writeActorId, revision: input.expectedRevision + 1,
    enabled: input.enabled, profile: input.profile, fieldSources, createdAt: prior?.createdAt ?? now, updatedAt: now });
}
function replayed(prior: StoredProfile | undefined, receipt: Mutation | undefined, requestSha256: string) {
  if (!receipt) return false;
  if (receipt.requestSha256 !== requestSha256) throw new PersonalProfileError("This save identifier was already used for another change. Reload and try again.", 409, "personal_profile_idempotency_conflict");
  if (!prior || prior.revision < receipt.revision || prior.actorId !== receipt.actorId) throw unavailable();
  // Return the newest profile: an old retry must never restore cleared personal facts.
  return true;
}
function response(value?: StoredProfile): PersonalProfileResponse {
  return { schemaVersion: 1, contract: PERSONAL_PROFILE_CONTRACT,
    revision: value?.revision ?? 0, enabled: value?.enabled ?? false,
    profile: value?.profile ?? { ...EMPTY_PERSONAL_PROFILE }, fieldSources: value?.fieldSources ?? {}, updatedAt: value?.updatedAt ?? null };
}
async function readSql(sql: SqlClient, coordinates: CompanionOwnerCoordinates) {
  const rows = await sql`SELECT * FROM omni_personal_profiles WHERE tenant_id = ${coordinates.tenantId}
    AND (actor_id = ${coordinates.readableActorIds[0]} OR actor_id = ${coordinates.requestActorId}) LIMIT 2`;
  if (rows.length > 1) throw unavailable();
  return rows[0] ? parseRow(rows[0], coordinates) : undefined;
}
function parseRow(row: SqlRow, coordinates: CompanionOwnerCoordinates) {
  const parsed = storedSchema.safeParse({ schemaVersion: row.schema_version, tenantId: row.tenant_id, actorId: row.actor_id,
    revision: Number(row.revision), enabled: row.enabled, profile: row.profile, fieldSources: row.field_sources,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
  if (!parsed.success || !scoped(parsed.data, coordinates)) throw unavailable();
  return parsed.data;
}
function parseMutationRow(row: SqlRow, coordinates: CompanionOwnerCoordinates) {
  const parsed = mutationSchema.safeParse({ tenantId: row.tenant_id, actorId: row.actor_id,
    keySha256: row.idempotency_sha256, requestSha256: row.request_sha256, revision: Number(row.revision), savedAt: iso(row.saved_at) });
  if (!parsed.success || !scoped(parsed.data, coordinates)) throw unavailable();
  return parsed.data;
}
function scoped(value: unknown, coordinates: CompanionOwnerCoordinates): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).tenantId === coordinates.tenantId &&
    coordinates.readableActorIds.includes((value as Record<string, unknown>).actorId as string));
}
function current(ledger: Ledger, coordinates: CompanionOwnerCoordinates) {
  const rows = ledger.profiles.filter(value => scoped(value, coordinates));
  if (rows.length > 1) throw unavailable();
  if (!rows.length) return undefined;
  const result = storedSchema.safeParse(rows[0]);
  if (!result.success) throw unavailable();
  return result.data;
}
function assertLocal() { if (process.env.VERCEL || process.env.NODE_ENV === "production") throw unavailable(); }
function ledgerPath() { return getDataPath("personal-profiles.json"); }
function iso(value: unknown) { return value instanceof Date ? value.toISOString() : value; }
async function readLedger(): Promise<Ledger> {
  let contents: string;
  try { contents = await readFile(ledgerPath(), "utf8"); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { schemaVersion: 1, profiles: [], mutations: [] };
    throw unavailable();
  }
  try {
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== 1 || !Array.isArray(record.profiles) || !Array.isArray(record.mutations) ||
      Object.keys(record).sort().join(",") !== "mutations,profiles,schemaVersion") throw unavailable();
    return record as Ledger;
  } catch { throw unavailable(); }
}
