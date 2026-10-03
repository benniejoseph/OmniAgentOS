import { createHash } from "node:crypto";
import { z } from "zod";
import {
  companionChangeSchema, companionPreferencesSchema, DEFAULT_COMPANION_PREFERENCES,
  type CompanionChange, type CompanionSnapshot,
} from "@/lib/companion/contracts";
import { canonicalActorIdFromExactRequestBinding, type CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const exactText = (max: number) => z.string().min(1).max(max).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const instant = z.string().datetime().refine((value) => new Date(value).toISOString() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const storedCompanionSchema = z.object({
  schemaVersion: z.literal(1), tenantId: exactText(240), actorId: exactText(320),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  preferences: companionPreferencesSchema, createdAt: instant, updatedAt: instant,
}).strict().refine((value) => value.createdAt <= value.updatedAt);
export const companionMutationSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^companion:[a-f0-9]{64}$/),
  tenantId: exactText(240), actorId: exactText(320), idempotencySha256: digest, requestSha256: digest,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  preferences: companionPreferencesSchema, savedAt: instant,
}).strict().refine((value) => value.revision === value.expectedRevision + 1);
export type StoredCompanion = z.infer<typeof storedCompanionSchema>;
export type CompanionMutation = z.infer<typeof companionMutationSchema>;
export type CompanionOwner = { tenantId: string; actorId: string; requestActorBinding?: CanonicalRequestActorBindingV1 };
export type CompanionOwnerCoordinates = { tenantId: string; requestActorId: string; writeActorId: string; readableActorIds: readonly string[] };
export type CompanionThreadCheck = { id: string; state: "available" | "unavailable" | "unconfirmed" };
export type CompanionStoredChange = { current: StoredCompanion; receipt: CompanionMutation; replayed: boolean };

export class CompanionPreferencesError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 503, readonly code: string) {
    super(message); this.name = "CompanionPreferencesError";
  }
}

export function companionOwnerCoordinates(owner: CompanionOwner): CompanionOwnerCoordinates {
  if (!exactText(240).safeParse(owner.tenantId).success || !exactText(320).safeParse(owner.actorId).success) {
    throw new CompanionPreferencesError("Companion owner scope is invalid.", 400, "companion_scope_invalid");
  }
  const binding = owner.requestActorBinding;
  const canonical = binding && Array.isArray(binding.legacyOwnerActorIds) && Array.isArray(binding.readableOwnerActorIds)
    ? canonicalActorIdFromExactRequestBinding(owner.actorId, binding) : undefined;
  return {
    tenantId: owner.tenantId, requestActorId: owner.actorId, writeActorId: canonical ?? owner.actorId,
    readableActorIds: canonical ? [canonical, owner.actorId] : [owner.actorId],
  };
}

export function companionSnapshot(current?: StoredCompanion): CompanionSnapshot {
  return current ? { revision: current.revision, persisted: true, updatedAt: current.updatedAt, preferences: current.preferences }
    : { revision: 0, persisted: false, updatedAt: null, preferences: { ...DEFAULT_COMPANION_PREFERENCES } };
}

export function companionRequestHash(input: CompanionChange) { return hash(companionChangeSchema.parse(input)); }
export function companionIdempotencyHash(key: string) {
  if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(key)) {
    throw new CompanionPreferencesError("An opaque Idempotency-Key is required.", 400, "companion_idempotency_invalid");
  }
  return hash(["companion-preference-idempotency:1", key]);
}

/** Called only under the adapter's owner lock/transaction. No thread or execution effects occur here. */
export function prepareCompanionChange(
  coordinates: CompanionOwnerCoordinates,
  current: StoredCompanion | undefined,
  existing: CompanionMutation | undefined,
  input: CompanionChange,
  idempotencyKey: string,
  threadCheck: CompanionThreadCheck | undefined,
  now: string,
): CompanionStoredChange {
  const value = companionChangeSchema.parse(input);
  const requestSha256 = companionRequestHash(value);
  const idempotencySha256 = companionIdempotencyHash(idempotencyKey);
  const preferences = value.action === "reset" ? { ...DEFAULT_COMPANION_PREFERENCES } : value.preferences;
  if (current && (current.tenantId !== coordinates.tenantId || !coordinates.readableActorIds.includes(current.actorId))) throw storageInvalid();
  if (existing) {
    if (existing.requestSha256 !== requestSha256 || existing.idempotencySha256 !== idempotencySha256) {
      throw new CompanionPreferencesError("This Idempotency-Key belongs to a different preference change.", 409, "companion_idempotency_conflict");
    }
    if (!current || current.revision < existing.revision || current.actorId !== existing.actorId ||
      existing.tenantId !== coordinates.tenantId || existing.id !== `companion:${hash([coordinates.tenantId, existing.actorId, idempotencySha256])}` ||
      existing.expectedRevision !== value.expectedRevision || JSON.stringify(existing.preferences) !== JSON.stringify(preferences) ||
      (current.revision === existing.revision && (current.updatedAt !== existing.savedAt || JSON.stringify(current.preferences) !== JSON.stringify(existing.preferences)))) throw storageInvalid();
    return { current, receipt: existing, replayed: true };
  }
  if ((current?.revision ?? 0) !== value.expectedRevision) {
    throw new CompanionPreferencesError("Companion preferences changed. Reload before saving again.", 409, "companion_revision_conflict");
  }
  const target = preferences.preferredThreadId;
  if (target !== null && target !== current?.preferences.preferredThreadId) {
    if (!threadCheck || threadCheck.id !== target || threadCheck.state === "unconfirmed") {
      throw new CompanionPreferencesError("The preferred conversation could not be checked. Try again.", 503, "companion_thread_unconfirmed");
    }
    if (threadCheck.state !== "available") {
      throw new CompanionPreferencesError("That conversation is unavailable to this account.", 404, "companion_thread_unavailable");
    }
  }
  const actorId = current?.actorId ?? coordinates.writeActorId;
  const updated: StoredCompanion = storedCompanionSchema.parse({
    schemaVersion: 1, tenantId: coordinates.tenantId, actorId, revision: value.expectedRevision + 1,
    preferences, createdAt: current?.createdAt ?? now, updatedAt: now,
  });
  const receipt: CompanionMutation = companionMutationSchema.parse({
    schemaVersion: 1, id: `companion:${hash([coordinates.tenantId, actorId, idempotencySha256])}`,
    tenantId: coordinates.tenantId, actorId, idempotencySha256, requestSha256,
    expectedRevision: value.expectedRevision, revision: updated.revision, preferences, savedAt: now,
  });
  return { current: updated, receipt, replayed: false };
}

export function storageInvalid() { return new CompanionPreferencesError("Stored Companion preferences could not be verified.", 503, "companion_storage_invalid"); }
export function ownerConflict() { return new CompanionPreferencesError("Companion preference ownership is ambiguous.", 409, "companion_owner_conflict"); }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
