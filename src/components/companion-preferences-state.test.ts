import { describe, expect, it } from "vitest";
import { COMPANION_PREFERENCES_CONTRACT, DEFAULT_COMPANION_PREFERENCES, type CompanionPreferencesResponse } from "@/lib/companion/contracts";
import {
  applyCompanionRead, applyCompanionReceipt, companionDraftIsDirty, companionRefusalSettlesSubmission, companionWriteRejection,
  createCompanionRequestGate, freezeCompanionSubmission, parseCompanionConversations, parseCompanionResponse,
  type CompanionEditor,
} from "@/components/companion-preferences-state";

const now = "2026-10-03T10:00:00.000Z";
const homeId = "11111111-1111-4111-8111-111111111111";
function snapshot(revision = 0): CompanionPreferencesResponse {
  return { schemaVersion: 1, contract: COMPANION_PREFERENCES_CONTRACT,
    snapshot: { revision, persisted: revision > 0, updatedAt: revision > 0 ? now : null, preferences: { ...DEFAULT_COMPANION_PREFERENCES } },
    home: { state: "not_set", preferredThreadId: null, href: null, fallbackHref: "/app/command" },
    destination: { href: "/app/command", state: "configured" } };
}
function dirtyEditor(): CompanionEditor {
  const editor = applyCompanionRead({}, snapshot());
  return { ...editor, draft: { ...editor.draft!, intensity: "quiet" } };
}
function accepted(revision = 1): CompanionPreferencesResponse {
  const response = snapshot(revision);
  response.snapshot.preferences.intensity = "quiet";
  response.mutation = { outcome: "saved", receiptId: `companion:${"a".repeat(64)}`, revision, savedAt: now, preferences: { ...response.snapshot.preferences } };
  return response;
}

describe("Companion browser receipt and draft contract", () => {
  it("accepts exact defaults and rejects incomplete success or invented persisted defaults", () => {
    expect(parseCompanionResponse(snapshot())).toEqual(snapshot());
    expect(parseCompanionResponse({})).toBeUndefined();
    expect(parseCompanionResponse({ ...snapshot(), snapshot: { ...snapshot().snapshot, persisted: true } })).toBeUndefined();
    const nondefault = snapshot(); nondefault.snapshot.preferences.visible = false;
    expect(parseCompanionResponse(nondefault)).toBeUndefined();
  });

  it("binds the availability and internal destination to the exact saved home", () => {
    const response = snapshot(1);
    response.snapshot.preferences.preferredThreadId = homeId;
    response.home = { ...response.home, state: "available", preferredThreadId: homeId, href: `/app/command?thread=${homeId}` };
    response.destination.href = response.home.href!;
    expect(parseCompanionResponse(response)).toEqual(response);
    expect(parseCompanionResponse({ ...response, home: { ...response.home, href: "https://other.example" } })).toBeUndefined();
    expect(parseCompanionResponse({ ...response, destination: { href: "/app", state: "configured" } })).toBeUndefined();
    response.home.state = "unavailable"; response.home.href = null;
    response.destination = { href: "/app/command", state: "fallback" };
    expect(parseCompanionResponse(response)).toEqual(response);
  });

  it("freezes the exact request body, expected revision and key while later drafts change", () => {
    const editor = dirtyEditor();
    const submission = freezeCompanionSubmission(editor, "save", "request-a")!;
    editor.draft!.visible = false;
    expect(JSON.parse(submission.serializedBody)).toEqual({ action: "save", expectedRevision: 0, preferences: { ...DEFAULT_COMPANION_PREFERENCES, intensity: "quiet" } });
    expect(submission.key).toBe("request-a");
    expect(Object.isFrozen(submission.body)).toBe(true);
    expect(Object.isFrozen(submission.draftAtStart)).toBe(true);
    expect(freezeCompanionSubmission({ ...editor, submission }, "save", "request-b")).toBeUndefined();
    expect(freezeCompanionSubmission({ ...editor, draftRevision: 8 }, "save", "request-b")).toBeUndefined();
  });

  it("refuses an invalid draft or exhausted revision before constructing any submission", () => {
    const editor = dirtyEditor();
    expect(() => freezeCompanionSubmission({ ...editor, draft: { ...editor.draft!, preferredThreadId: "opaque-thread" } }, "save", "request-a")).toThrow();
    const exhausted = { ...editor, current: snapshot(Number.MAX_SAFE_INTEGER), draftRevision: Number.MAX_SAFE_INTEGER };
    expect(() => freezeCompanionSubmission(exhausted, "save", "request-a")).toThrow();
    expect(() => freezeCompanionSubmission(exhausted, "reset", "request-a")).toThrow();
  });

  it("requires an exact revision and preferences receipt, rather than any successful response", () => {
    const submission = freezeCompanionSubmission(dirtyEditor(), "save", "request-a")!;
    const response = accepted();
    expect(parseCompanionResponse(response, submission)).toEqual(response);
    expect(parseCompanionResponse(response)).toBeUndefined();
    expect(parseCompanionResponse(snapshot(1), submission)).toBeUndefined();
    expect(parseCompanionResponse({ ...response, mutation: { ...response.mutation!, revision: 2 } }, submission)).toBeUndefined();
    expect(parseCompanionResponse({ ...response, mutation: { ...response.mutation!, preferences: DEFAULT_COMPANION_PREFERENCES } }, submission)).toBeUndefined();
    expect(parseCompanionResponse({ ...response, mutation: { ...response.mutation!, savedAt: "2026-10-03T11:00:00.000Z" } }, submission)).toBeUndefined();
  });

  it("requires reset to confirm every default while preserving edits made during the request", () => {
    const editor = dirtyEditor();
    const submission = freezeCompanionSubmission(editor, "reset", "reset-a")!;
    const response = snapshot(1);
    response.mutation = { outcome: "saved", receiptId: `companion:${"b".repeat(64)}`, revision: 1, savedAt: now, preferences: { ...DEFAULT_COMPANION_PREFERENCES } };
    expect(parseCompanionResponse(response, submission)).toEqual(response);
    const changed = { ...editor, submission, draft: { ...editor.draft!, visible: false } };
    const result = applyCompanionReceipt(changed, response, submission);
    expect(result.draft).toEqual(changed.draft);
    expect(result.draftRevision).toBe(1);
    expect(result.submission).toBeUndefined();
    expect(result.receipt).toEqual(response.mutation);
  });

  it("settles a matching untouched draft and retains subsequent edits as unsaved", () => {
    const editor = dirtyEditor();
    const submission = freezeCompanionSubmission(editor, "save", "save-a")!;
    const untouched = applyCompanionReceipt({ ...editor, submission }, accepted(), submission);
    expect(companionDraftIsDirty(untouched)).toBe(false);
    const duringSave = { ...editor, submission, draft: { ...editor.draft!, motion: "off" as const } };
    const result = applyCompanionReceipt(duringSave, accepted(), submission);
    expect(companionDraftIsDirty(result)).toBe(true);
    expect(result.draft!.motion).toBe("off");
    expect(result.draftRevision).toBe(1);
  });

  it("preserves an edited or unresolved draft across newer GETs and never treats a GET as a receipt", () => {
    const editor = dirtyEditor();
    const submission = freezeCompanionSubmission(editor, "save", "save-a")!;
    const refreshed = applyCompanionRead({ ...editor, submission }, snapshot(3));
    expect(refreshed.draft).toEqual(editor.draft);
    expect(refreshed.draftRevision).toBe(0);
    expect(refreshed.submission).toBe(submission);
    expect(refreshed.receipt).toBeUndefined();
    expect(freezeCompanionSubmission(refreshed, "save", "save-b")).toBeUndefined();
  });

  it("retains the older accepted replay receipt alongside newer saved values without rebasing the draft", () => {
    const editor = dirtyEditor(); const submission = freezeCompanionSubmission(editor, "save", "save-a")!;
    const response = snapshot(3); response.snapshot.preferences.visible = false;
    response.mutation = { ...accepted().mutation!, outcome: "replayed" };
    expect(parseCompanionResponse(response, submission)).toEqual(response);
    const result = applyCompanionReceipt({ ...editor, submission }, response, submission);
    expect(result.current!.snapshot.revision).toBe(3);
    expect(result.receipt!.revision).toBe(1);
    expect(result.draft).toEqual(editor.draft);
    expect(result.draftRevision).toBe(0);
  });

  it("does not regress a confirmed snapshot or discard its receipt on an unrelated refresh", () => {
    const editor = dirtyEditor(); const submission = freezeCompanionSubmission(editor, "save", "save-a")!;
    const saved = applyCompanionReceipt({ ...editor, submission }, accepted(), submission);
    expect(applyCompanionRead(saved, snapshot())).toBe(saved);
    const latest = snapshot(2);
    expect(applyCompanionRead(saved, latest).receipt).toEqual(saved.receipt);
    const conflict = snapshot(1);
    expect(() => applyCompanionRead(saved, conflict)).toThrow("could not be verified");
  });

  it("distinguishes known write refusals from uncertain transport/proxy/malformed outcomes", () => {
    expect(companionWriteRejection(409, { code: "companion_revision_conflict" })).toContain("Saved preferences changed");
    expect(companionWriteRejection(404, { code: "companion_thread_unavailable" })).toContain("selected conversation");
    for (const [status, value] of [[200, {}], [503, { error: "unavailable" }], [409, { code: "unknown" }], [500, { code: "companion_revision_conflict" }]] as const) expect(companionWriteRejection(status, value)).toBeUndefined();
  });

  it("does not erase an earlier uncertain save when a retry is refused before stored replay lookup", () => {
    expect(companionRefusalSettlesSubmission(403, { code: "companion_preferences_forbidden" }, false)).toBe(true);
    expect(companionRefusalSettlesSubmission(403, { code: "companion_preferences_forbidden" }, true)).toBe(false);
    expect(companionRefusalSettlesSubmission(400, { code: "companion_preferences_invalid" }, true)).toBe(false);
    expect(companionRefusalSettlesSubmission(409, { code: "companion_owner_conflict" }, true)).toBe(false);
    expect(companionRefusalSettlesSubmission(409, { code: "companion_revision_conflict" }, true)).toBe(true);
    expect(companionRefusalSettlesSubmission(404, { code: "companion_thread_unavailable" }, true)).toBe(true);
  });
});

describe("Companion owned conversation choices", () => {
  const row = { id: homeId, tenantId: "tenant-a", actorId: "actor-a", title: "A conversation", mode: "orchestrate", updatedAt: now, privateBody: "do not project" };
  it("projects only the bounded supported owned metadata and excludes wrong scope or unsupported IDs", () => {
    const result = parseCompanionConversations({ threads: [row, { ...row, id: "opaque-id" }, { ...row, actorId: "actor-b" }, { ...row, tenantId: "tenant-b" }] }, "tenant-a", "actor-a")!;
    expect(result.omitted).toBe(3);
    expect(result.threads).toEqual([{ id: homeId, title: row.title, mode: row.mode, updatedAt: now }]);
    expect(JSON.stringify(result)).not.toContain("do not project");
    expect(parseCompanionConversations({ threads: Array.from({ length: 101 }, () => row) }, "tenant-a", "actor-a")).toBeUndefined();
  });
  it("distinguishes an empty response from missing rows and drops ambiguous duplicate identities", () => {
    expect(parseCompanionConversations({ threads: [] }, "tenant-a", "actor-a")).toEqual({ threads: [], omitted: 0 });
    expect(parseCompanionConversations({}, "tenant-a", "actor-a")).toBeUndefined();
    expect(parseCompanionConversations({ threads: [row, { ...row, title: "Different" }] }, "tenant-a", "actor-a")).toEqual({ threads: [], omitted: 2 });
  });
});

describe("Companion lifecycle request slots", () => {
  it("synchronously blocks duplicate writes and fences reads started before a write", () => {
    const gate = createCompanionRequestGate(); gate.activate();
    const read = gate.beginRead()!; const write = gate.beginWrite()!;
    expect(gate.readCurrent(read)).toBe(false);
    expect(gate.beginWrite()).toBeUndefined(); expect(gate.beginRead()).toBeUndefined();
    gate.finishWrite(write);
    expect(gate.writeCurrent(write)).toBe(false);
    expect(gate.beginRead()).toBeDefined();
  });
  it("prevents stale reads, list results and writes from surviving disposal or replacement activation", () => {
    const gate = createCompanionRequestGate(); gate.activate();
    const read = gate.beginRead()!; const laterRead = gate.beginRead()!;
    expect(gate.readCurrent(read)).toBe(false); expect(gate.readCurrent(laterRead)).toBe(true);
    const threads = gate.beginConversations()!; const laterThreads = gate.beginConversations()!;
    expect(gate.conversationsCurrent(threads)).toBe(false); expect(gate.conversationsCurrent(laterThreads)).toBe(true);
    const write = gate.beginWrite()!;
    gate.dispose(); gate.activate();
    expect(gate.readCurrent(laterRead)).toBe(false); expect(gate.conversationsCurrent(laterThreads)).toBe(false); expect(gate.writeCurrent(write)).toBe(false);
    const replacement = gate.beginWrite()!; gate.finishWrite(write);
    expect(gate.writeCurrent(replacement)).toBe(true);
  });
});
