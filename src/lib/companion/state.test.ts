import { describe, expect, it } from "vitest";
import { companionChangeSchema, DEFAULT_COMPANION_PREFERENCES, effectiveCompanionMotion, type CompanionChange } from "@/lib/companion/contracts";
import { companionOwnerCoordinates, companionSnapshot, prepareCompanionChange } from "@/lib/companion/state";

const owner = { tenantId: "tenant-a", actorId: "owner@example.test" };
const coordinates = companionOwnerCoordinates(owner);
const now = "2026-10-03T10:00:00.000Z";
const threadId = "22222222-2222-4222-8222-222222222222";
const change: CompanionChange = { action: "save", expectedRevision: 0, preferences: { ...DEFAULT_COMPANION_PREFERENCES, intensity: "quiet" } };

describe("Companion preference revision contract", () => {
  it("provides unsaved defaults without inventing a persisted revision", () => {
    expect(companionSnapshot()).toEqual({ revision: 0, persisted: false, updatedAt: null, preferences: DEFAULT_COMPANION_PREFERENCES });
  });

  it("keeps independent visibility and motion preferences and honors the OS motion floor", () => {
    expect(companionChangeSchema.parse({ ...change, preferences: { ...change.preferences, intensity: "expressive", visible: false, motion: "off" } })).toMatchObject({
      preferences: { intensity: "expressive", visible: false, motion: "off" },
    });
    expect(effectiveCompanionMotion("full", true)).toBe("reduced");
    expect(effectiveCompanionMotion("full", false)).toBe("full");
    expect(effectiveCompanionMotion("reduced", false)).toBe("reduced");
    expect(effectiveCompanionMotion("off", true)).toBe("off");
  });

  it("rejects authority fields, fractional revisions, and home IDs unsupported by web/native navigation", () => {
    for (const value of [
      { ...change, actorId: "other-owner" }, { ...change, expectedRevision: 0.5 },
      { ...change, preferences: { ...change.preferences, preferredThreadId: "opaque-legacy-thread" } },
      { ...change, preferences: { ...change.preferences, notificationConsent: true } },
    ]) expect(companionChangeSchema.safeParse(value).success).toBe(false);
    expect(companionChangeSchema.safeParse({ ...change, preferences: { ...change.preferences, preferredThreadId: threadId } }).success).toBe(true);
  });

  it("uses only the exact canonical bridge and preserves independent scope coordinates", () => {
    const authUserId = "11111111-1111-4111-8111-111111111111";
    const canonicalActorId = `actor:${authUserId}`;
    const binding = { version: 1 as const, kind: "auth_user" as const, authUserId, canonicalActorId,
      legacyOwnerActorIds: [owner.actorId], readableOwnerActorIds: [canonicalActorId, owner.actorId] };
    expect(companionOwnerCoordinates({ ...owner, requestActorBinding: binding }).writeActorId).toBe(canonicalActorId);
    expect(companionOwnerCoordinates({ ...owner, requestActorBinding: { ...binding, readableOwnerActorIds: [canonicalActorId, owner.actorId, "other"] } }).readableActorIds).toEqual([owner.actorId]);
    expect(() => companionOwnerCoordinates({ ...owner, actorId: " owner@example.test " })).toThrow("scope is invalid");
  });

  it("records one revision and replays an older accepted change without rolling back the current snapshot", () => {
    const first = prepareCompanionChange(coordinates, undefined, undefined, change, "save-a", undefined, now);
    const later = prepareCompanionChange(coordinates, first.current, undefined, { action: "reset", expectedRevision: 1 }, "reset-a", undefined, now);
    const replay = prepareCompanionChange(coordinates, later.current, first.receipt, change, "save-a", undefined, now);
    expect(replay.replayed).toBe(true);
    expect(replay.current.revision).toBe(2);
    expect(replay.current.preferences.intensity).toBe("balanced");
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.receipt.revision).toBe(1);
    expect(replay.receipt.preferences.intensity).toBe("quiet");
    expect(JSON.stringify(first.receipt)).not.toContain("save-a");
  });

  it("rejects stale revisions and a changed submission reusing a recorded key", () => {
    const first = prepareCompanionChange(coordinates, undefined, undefined, change, "save-a", undefined, now);
    expect(() => prepareCompanionChange(coordinates, first.current, undefined, change, "new-key", undefined, now)).toThrow("Reload before saving");
    expect(() => prepareCompanionChange(coordinates, first.current, first.receipt, { ...change, preferences: { ...change.preferences, visible: false } }, "save-a", undefined, now)).toThrow("different preference change");
    expect(() => prepareCompanionChange(coordinates, first.current, { ...first.receipt, preferences: { ...first.receipt.preferences, visible: false } }, change, "save-a", undefined, now)).toThrow("could not be verified");
  });

  it("requires a confirmed owned destination only when a new home target is designated", () => {
    const designated: CompanionChange = { ...change, preferences: { ...change.preferences, preferredThreadId: threadId } };
    expect(() => prepareCompanionChange(coordinates, undefined, undefined, designated, "home-a", { id: threadId, state: "unavailable" }, now)).toThrow("unavailable to this account");
    expect(() => prepareCompanionChange(coordinates, undefined, undefined, designated, "home-a", { id: threadId, state: "unconfirmed" }, now)).toThrow("could not be checked");
    const first = prepareCompanionChange(coordinates, undefined, undefined, designated, "home-a", { id: threadId, state: "available" }, now);
    const changed = prepareCompanionChange(coordinates, first.current, undefined, { ...designated, expectedRevision: 1, preferences: { ...designated.preferences, visible: false } }, "style-a", { id: threadId, state: "unavailable" }, now);
    expect(changed.current.preferences.preferredThreadId).toBe(threadId);
    expect(changed.current.preferences.visible).toBe(false);
    expect(prepareCompanionChange(coordinates, changed.current, first.receipt, designated, "home-a", { id: threadId, state: "unavailable" }, now).replayed).toBe(true);
  });
});
