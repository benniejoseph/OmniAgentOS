import {
  COMPANION_DESTINATIONS, COMPANION_INTENSITIES, COMPANION_MOTION, COMPANION_PREFERENCES_CONTRACT,
  type CompanionChange, type CompanionPreferences, type CompanionPreferencesResponse,
} from "./model";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!record(value) || !required.every((key) => Object.hasOwn(value, key))) return false;
  for (const key in value) if (!required.includes(key) && !optional.includes(key)) return false;
  return true;
}
function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}
function revision(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

// Match the server's z.string().uuid(): RFC variants/versions 1–8, plus nil/max.
// The all-max spelling is deliberately lowercase, as in the installed schema.
const threadIdPattern = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
function threadId(value: unknown): value is string {
  return typeof value === "string" && threadIdPattern.test(value);
}
// Match datetime({ offset: true }), including optional seconds/fractional seconds.
// Calendar arithmetic avoids Date's rollover, timezone and years 0–99 behavior.
const instantPattern = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
function instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = instantPattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

/** Public JSON parsers clone only verified fields; server schemas remain authoritative. */
export function parseBrowserCompanionPreferences(value: unknown): CompanionPreferences | undefined {
  if (!exact(value, ["intensity", "visible", "motion", "defaultDestination", "preferredThreadId"]) ||
    !member(COMPANION_INTENSITIES, value.intensity) || typeof value.visible !== "boolean" ||
    !member(COMPANION_MOTION, value.motion) || !member(COMPANION_DESTINATIONS, value.defaultDestination) ||
    (value.preferredThreadId !== null && !threadId(value.preferredThreadId))) return undefined;
  return { intensity: value.intensity, visible: value.visible, motion: value.motion,
    defaultDestination: value.defaultDestination, preferredThreadId: value.preferredThreadId };
}

export function parseBrowserCompanionChange(value: unknown): CompanionChange | undefined {
  if (!record(value) || !revision(value.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1)) return undefined;
  if (value.action === "reset" && exact(value, ["action", "expectedRevision"])) {
    return { action: value.action, expectedRevision: value.expectedRevision };
  }
  if (value.action !== "save" || !exact(value, ["action", "expectedRevision", "preferences"])) return undefined;
  const preferences = parseBrowserCompanionPreferences(value.preferences);
  return preferences ? { action: value.action, expectedRevision: value.expectedRevision, preferences } : undefined;
}

/** Structural checks only. The editor additionally binds home, snapshot and submission identities. */
export function parseBrowserCompanionEnvelope(value: unknown): CompanionPreferencesResponse | undefined {
  if (!exact(value, ["schemaVersion", "contract", "snapshot", "home", "destination"], ["mutation"]) ||
    value.schemaVersion !== 1 || value.contract !== COMPANION_PREFERENCES_CONTRACT) return undefined;
  const { snapshot, home, destination } = value;
  if (!exact(snapshot, ["revision", "persisted", "updatedAt", "preferences"]) || !revision(snapshot.revision) ||
    typeof snapshot.persisted !== "boolean" || (snapshot.updatedAt !== null && !instant(snapshot.updatedAt))) return undefined;
  const preferences = parseBrowserCompanionPreferences(snapshot.preferences);
  if (!preferences || !exact(home, ["state", "preferredThreadId", "href", "fallbackHref"]) ||
    !member(["not_set", "available", "unavailable", "unconfirmed"], home.state) ||
    (home.preferredThreadId !== null && !threadId(home.preferredThreadId)) ||
    (home.href !== null && typeof home.href !== "string") || home.fallbackHref !== "/app/command" ||
    !exact(destination, ["href", "state"]) || typeof destination.href !== "string" ||
    !member(["configured", "fallback"], destination.state)) return undefined;
  let mutation: CompanionPreferencesResponse["mutation"];
  if (value.mutation !== undefined) {
    const item = value.mutation;
    if (!exact(item, ["outcome", "receiptId", "revision", "savedAt", "preferences"]) ||
      !member(["saved", "replayed"], item.outcome) || typeof item.receiptId !== "string" ||
      !/^companion:[a-f0-9]{64}$/.test(item.receiptId) || !revision(item.revision, 1) || !instant(item.savedAt)) return undefined;
    const accepted = parseBrowserCompanionPreferences(item.preferences);
    if (!accepted) return undefined;
    mutation = { outcome: item.outcome, receiptId: item.receiptId, revision: item.revision, savedAt: item.savedAt, preferences: accepted };
  }
  return { schemaVersion: 1, contract: COMPANION_PREFERENCES_CONTRACT,
    snapshot: { revision: snapshot.revision, persisted: snapshot.persisted, updatedAt: snapshot.updatedAt, preferences },
    home: { state: home.state, preferredThreadId: home.preferredThreadId, href: home.href, fallbackHref: home.fallbackHref },
    destination: { href: destination.href, state: destination.state },
    ...("mutation" in value ? { mutation } : {}) };
}

/** Thread envelopes carry additional metadata; copy only this owned, bounded public projection. */
export function parseBrowserCompanionConversation(value: unknown, tenantId: string, actorId: string) {
  if (!record(value) || !threadId(value.id) || value.tenantId !== tenantId || value.actorId !== actorId ||
    typeof value.title !== "string" || value.title.length < 1 || value.title.length > 2_000 || !instant(value.updatedAt) ||
    !member(["orchestrate", "research", "execute", "learn"], value.mode)) return undefined;
  return { id: value.id, title: value.title, updatedAt: value.updatedAt, mode: value.mode };
}
