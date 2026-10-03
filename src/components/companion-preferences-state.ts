import {
  DEFAULT_COMPANION_PREFERENCES,
  type CompanionChange, type CompanionPreferences, type CompanionPreferencesResponse,
} from "@/lib/companion/model";
import { parseBrowserCompanionChange, parseBrowserCompanionConversation, parseBrowserCompanionEnvelope } from "@/lib/companion/browser-validation";

export type CompanionSubmission = Readonly<{
  key: string;
  body: CompanionChange;
  serializedBody: string;
  draftAtStart: CompanionPreferences;
}>;
export type CompanionEditor = {
  current?: CompanionPreferencesResponse;
  draft?: CompanionPreferences;
  draftRevision?: number;
  submission?: CompanionSubmission;
  submissionUncertain?: boolean;
  receipt?: NonNullable<CompanionPreferencesResponse["mutation"]>;
};
export type CompanionConversation = { id: string; title: string; updatedAt: string; mode: string };

export function sameCompanionPreferences(a: CompanionPreferences, b: CompanionPreferences) {
  return a.intensity === b.intensity && a.visible === b.visible && a.motion === b.motion &&
    a.defaultDestination === b.defaultDestination && a.preferredThreadId === b.preferredThreadId;
}
export function companionDraftIsDirty(editor: CompanionEditor) {
  return Boolean(editor.draft && editor.current && !sameCompanionPreferences(editor.draft, editor.current.snapshot.preferences));
}
export function freezeCompanionSubmission(editor: CompanionEditor, action: "save" | "reset", key: string): CompanionSubmission | undefined {
  if (editor.submission || !editor.current || !editor.draft || editor.draftRevision !== editor.current.snapshot.revision || !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(key)) return undefined;
  const body = parseBrowserCompanionChange(action === "reset"
    ? { action, expectedRevision: editor.draftRevision }
    : { action, expectedRevision: editor.draftRevision, preferences: { ...editor.draft } });
  if (!body) throw new Error("Companion preferences could not be verified for submission.");
  if (body.action === "save") Object.freeze(body.preferences);
  return Object.freeze({ key, body: Object.freeze(body), serializedBody: JSON.stringify(body), draftAtStart: Object.freeze({ ...editor.draft }) });
}

/** A successful HTTP response is not a confirmed setting until its public identities agree. */
export function parseCompanionResponse(value: unknown, submission?: CompanionSubmission): CompanionPreferencesResponse | undefined {
  const response = parseBrowserCompanionEnvelope(value);
  if (!response) return undefined;
  const { snapshot, home, destination, mutation } = response;
  if (snapshot.revision === 0
    ? snapshot.persisted || snapshot.updatedAt !== null || !sameCompanionPreferences(snapshot.preferences, DEFAULT_COMPANION_PREFERENCES)
    : !snapshot.persisted || snapshot.updatedAt === null) return undefined;
  const id = snapshot.preferences.preferredThreadId;
  if (home.preferredThreadId !== id || (id === null) !== (home.state === "not_set")) return undefined;
  if (home.href !== (home.state === "available" && id !== null ? `/app/command?thread=${id}` : null)) return undefined;
  const expectedHref = { assistant: home.href ?? "/app/command", today: "/app", activity: "/app/activity", work: "/app/projects" }[snapshot.preferences.defaultDestination];
  const expectedState = snapshot.preferences.defaultDestination === "assistant" && id !== null && home.href === null ? "fallback" : "configured";
  if (destination.href !== expectedHref || destination.state !== expectedState) return undefined;
  if (!submission) return mutation ? undefined : response;
  if (!mutation || mutation.revision !== submission.body.expectedRevision + 1 || mutation.revision > snapshot.revision) return undefined;
  const submittedPreferences = submission.body.action === "reset" ? DEFAULT_COMPANION_PREFERENCES : submission.body.preferences;
  if (!sameCompanionPreferences(mutation.preferences, submittedPreferences)) return undefined;
  if (mutation.revision === snapshot.revision && (!sameCompanionPreferences(mutation.preferences, snapshot.preferences) || mutation.savedAt !== snapshot.updatedAt)) return undefined;
  return response;
}

/** Refresh may advance the server snapshot, but never replaces an edited or unresolved draft. */
export function applyCompanionRead(editor: CompanionEditor, response: CompanionPreferencesResponse): CompanionEditor {
  if (editor.current && response.snapshot.revision < editor.current.snapshot.revision) return editor;
  if (editor.current && response.snapshot.revision === editor.current.snapshot.revision &&
    (!sameCompanionPreferences(response.snapshot.preferences, editor.current.snapshot.preferences) || response.snapshot.updatedAt !== editor.current.snapshot.updatedAt)) throw new Error("Saved preferences could not be verified. Your draft is retained.");
  const clean = !editor.draft || (!editor.submission && !companionDraftIsDirty(editor));
  return { ...editor, current: response, ...(clean ? { draft: { ...response.snapshot.preferences }, draftRevision: response.snapshot.revision } : {}) };
}

/** A receipt is independent of later reads and of the newer snapshot returned by an old replay. */
export function applyCompanionReceipt(editor: CompanionEditor, response: CompanionPreferencesResponse, submission: CompanionSubmission): CompanionEditor {
  if (editor.submission !== submission || !response.mutation) return editor;
  const current = editor.current && editor.current.snapshot.revision > response.snapshot.revision ? editor.current : response;
  const currentIsReceipt = current.snapshot.revision === response.mutation.revision;
  const untouched = Boolean(editor.draft && sameCompanionPreferences(editor.draft, submission.draftAtStart));
  return { ...editor, current, receipt: response.mutation, submission: undefined, submissionUncertain: false,
    ...(currentIsReceipt ? { draft: untouched ? { ...current.snapshot.preferences } : editor.draft, draftRevision: current.snapshot.revision } : {}) };
}

export function companionWriteRejection(status: number, value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const code = (value as Record<string, unknown>).code;
  const known: Record<string, { status: number; message: string }> = {
    companion_revision_conflict: { status: 409, message: "Saved preferences changed. Refresh, then review your draft against the current revision." },
    companion_idempotency_conflict: { status: 409, message: "This submission identity is already bound to different values. Refresh and review before saving again." },
    companion_owner_conflict: { status: 409, message: "Preference ownership is ambiguous. This change was not saved." },
    companion_thread_unavailable: { status: 404, message: "The selected conversation is unavailable to this account. Choose another conversation or clear the home choice." },
    companion_preferences_invalid: { status: 400, message: "The preference values were rejected. Your draft is retained." },
    companion_preferences_forbidden: { status: 403, message: "This account cannot save these preferences. Your draft is retained." },
  };
  return typeof code === "string" && Object.hasOwn(known, code) && known[code].status === status ? known[code].message : undefined;
}

/** A later pre-store refusal cannot disprove an earlier uncertain commit. These store
 * outcomes occur only after exact replay lookup and therefore can settle that uncertainty. */
export function companionRefusalSettlesSubmission(status: number, value: unknown, wasUncertain: boolean) {
  if (!companionWriteRejection(status, value)) return false;
  if (!wasUncertain) return true;
  const code = (value as Record<string, unknown>).code;
  return code === "companion_revision_conflict" || code === "companion_idempotency_conflict" || code === "companion_thread_unavailable";
}

/** /api/threads?limit=100 projects every row into the requesting actor's exact scope. */
export function parseCompanionConversations(value: unknown, tenantId: string, actorId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rows = (value as Record<string, unknown>).threads;
  if (!Array.isArray(rows) || rows.length > 100) return undefined;
  const accepted = rows.flatMap((row) => {
    const parsed = parseBrowserCompanionConversation(row, tenantId, actorId);
    return parsed ? [parsed] : [];
  });
  const counts = new Map<string, number>();
  for (const row of accepted) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  const threads: CompanionConversation[] = accepted.filter((row) => counts.get(row.id) === 1)
    .map(({ id, title, updatedAt, mode }) => ({ id, title, updatedAt, mode }));
  return { threads, omitted: rows.length - threads.length };
}

/** Synchronous slots fence double clicks, pre-write reads, disposal and replaced requests. */
export function createCompanionRequestGate() {
  let alive = false;
  let epoch = 0;
  let read: symbol | undefined;
  let write: symbol | undefined;
  let conversations: symbol | undefined;
  type Token = { epoch: number; identity: symbol };
  return {
    activate() { alive = true; epoch += 1; },
    dispose() { alive = false; epoch += 1; read = write = conversations = undefined; },
    beginRead(): Token | undefined { if (!alive || write) return undefined; read = Symbol(); return { epoch, identity: read }; },
    readCurrent(token: Token) { return alive && token.epoch === epoch && token.identity === read && !write; },
    beginWrite(): Token | undefined { if (!alive || write) return undefined; read = undefined; write = Symbol(); return { epoch, identity: write }; },
    writeCurrent(token: Token) { return alive && token.epoch === epoch && token.identity === write; },
    finishWrite(token: Token) { if (alive && token.epoch === epoch && token.identity === write) write = undefined; },
    beginConversations(): Token | undefined { if (!alive) return undefined; conversations = Symbol(); return { epoch, identity: conversations }; },
    conversationsCurrent(token: Token) { return alive && token.epoch === epoch && token.identity === conversations; },
  };
}
