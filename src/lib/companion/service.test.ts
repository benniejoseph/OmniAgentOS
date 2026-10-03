import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPANION_PREFERENCES, type CompanionChange } from "@/lib/companion/contracts";
import { companionOwnerCoordinates, prepareCompanionChange, type StoredCompanion } from "@/lib/companion/state";
import type { SecurityContext } from "@/lib/security/types";

vi.mock("@/lib/security/context", () => ({ canPerform: (role: string, action: string) =>
  ["viewer", "operator", "admin", "system"].includes(role) && ["read", "manage.own_preferences"].includes(action) }));
import { getCompanionPreferences, saveCompanionPreferences, type CompanionDependencies } from "@/lib/companion/service";

const context: SecurityContext = { tenantId: "tenant-a", actorId: "owner@example.test", role: "viewer", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", sessionId: "session-a", tenantName: "Tenant A" } };
const threadId = "22222222-2222-4222-8222-222222222222";
const otherThreadId = "33333333-3333-4333-8333-333333333333";
const now = "2026-10-03T10:00:00.000Z";
function current(preferredThreadId: string | null = threadId): StoredCompanion {
  return { schemaVersion: 1, tenantId: context.tenantId, actorId: context.actorId, revision: 3,
    preferences: { ...DEFAULT_COMPANION_PREFERENCES, preferredThreadId }, createdAt: now, updatedAt: now };
}
function dependencies() {
  return {
    read: vi.fn<CompanionDependencies["read"]>().mockResolvedValue(undefined),
    change: vi.fn<CompanionDependencies["change"]>(),
    getThread: vi.fn<CompanionDependencies["getThread"]>().mockImplementation(async (id, owner) => ({ id, tenantId: owner.tenantId, actorId: owner.actorId })),
  };
}

describe("Companion service", () => {
  it("reads defaults without writing preferences or creating a conversation", async () => {
    const reads = dependencies();
    const result = await getCompanionPreferences(context, reads);
    expect(result.snapshot).toMatchObject({ revision: 0, persisted: false, preferences: DEFAULT_COMPANION_PREFERENCES });
    expect(result.home).toEqual({ state: "not_set", preferredThreadId: null, href: null, fallbackHref: "/app/command" });
    expect(reads.change).not.toHaveBeenCalled();
    expect(reads.getThread).not.toHaveBeenCalled();
  });

  it("rechecks the exact saved home against current tenant, actor and canonical binding on every read", async () => {
    const reads = dependencies();
    reads.read.mockResolvedValue(current());
    const first = await getCompanionPreferences(context, reads);
    expect(first.home).toMatchObject({ state: "available", preferredThreadId: threadId, href: `/app/command?thread=${threadId}` });
    expect(reads.getThread).toHaveBeenCalledWith(threadId, expect.objectContaining({
      tenantId: context.tenantId, actorId: context.actorId,
      requestActorBinding: expect.objectContaining({ canonicalActorId: `actor:${context.auth!.userId}`, legacyOwnerActorIds: [context.actorId] }),
    }));
    reads.getThread.mockResolvedValue(null);
    const missing = await getCompanionPreferences(context, reads);
    expect(missing.home.state).toBe("unavailable");
    expect(missing.destination).toEqual({ href: "/app/command", state: "fallback" });
    expect(missing.snapshot).toEqual(first.snapshot);
    expect(reads.change).not.toHaveBeenCalled();
  });

  it("distinguishes read uncertainty from an inaccessible destination and does not leak thread details", async () => {
    const reads = dependencies();
    reads.read.mockResolvedValue(current());
    reads.getThread.mockRejectedValue(new Error("PRIVATE_THREAD_FAILURE"));
    const failed = await getCompanionPreferences(context, reads);
    expect(failed.home.state).toBe("unconfirmed");
    expect(failed.snapshot.revision).toBe(3);
    expect(JSON.stringify(failed)).not.toContain("PRIVATE_");
    for (const thread of [
      { id: threadId, tenantId: "tenant-b", actorId: context.actorId },
      { id: threadId, tenantId: context.tenantId, actorId: "other-actor" },
      { id: otherThreadId, tenantId: context.tenantId, actorId: context.actorId },
    ]) {
      reads.getThread.mockResolvedValue(thread);
      expect((await getCompanionPreferences(context, reads)).home.state).toBe("unavailable");
    }
  });

  it("saves through the exact owner and settles the accepted receipt without a follow-up read", async () => {
    const reads = dependencies();
    const input: CompanionChange = { action: "save", expectedRevision: 0, preferences: { ...DEFAULT_COMPANION_PREFERENCES, preferredThreadId: threadId } };
    reads.change.mockImplementation(async (owner, change, key, check) => prepareCompanionChange(companionOwnerCoordinates(owner), undefined, undefined, change, key, check, now));
    const saved = await saveCompanionPreferences(context, input, "fixture-save-a", reads);
    expect(saved.mutation).toMatchObject({ outcome: "saved", revision: 1, preferences: input.preferences });
    expect(saved.home.state).toBe("available");
    expect(reads.getThread).toHaveBeenCalledTimes(1);
    expect(reads.read).not.toHaveBeenCalled();
    expect(reads.change).toHaveBeenCalledWith(expect.objectContaining({ tenantId: context.tenantId, actorId: context.actorId }), input, "fixture-save-a", { id: threadId, state: "available" });
  });

  it("retains the current snapshot and old receipt separately when replaying a prior home selection", async () => {
    const reads = dependencies();
    const owner = companionOwnerCoordinates(context);
    const input: CompanionChange = { action: "save", expectedRevision: 0, preferences: { ...DEFAULT_COMPANION_PREFERENCES, preferredThreadId: threadId } };
    const first = prepareCompanionChange(owner, undefined, undefined, input, "save-a", { id: threadId, state: "available" }, now);
    const second = prepareCompanionChange(owner, first.current, undefined, { ...input, expectedRevision: 1, preferences: { ...input.preferences, preferredThreadId: otherThreadId } }, "save-b", { id: otherThreadId, state: "available" }, now);
    reads.change.mockResolvedValue({ current: second.current, receipt: first.receipt, replayed: true });
    const replay = await saveCompanionPreferences(context, input, "save-a", reads);
    expect(replay.snapshot).toMatchObject({ revision: 2, preferences: { preferredThreadId: otherThreadId } });
    expect(replay.mutation).toMatchObject({ outcome: "replayed", revision: 1, preferences: { preferredThreadId: threadId } });
    expect(replay.home).toMatchObject({ state: "unconfirmed", preferredThreadId: otherThreadId, href: null });
    expect(reads.getThread).toHaveBeenCalledTimes(1);
  });

  it("uses existing default destination routes while preserving the independently saved home choice", async () => {
    const reads = dependencies();
    reads.getThread.mockResolvedValue(null);
    for (const [destination, href] of [["today", "/app"], ["activity", "/app/activity"], ["work", "/app/projects"]] as const) {
      reads.read.mockResolvedValue({ ...current(), preferences: { ...current().preferences, defaultDestination: destination } });
      const result = await getCompanionPreferences(context, reads);
      expect(result.destination).toEqual({ href, state: "configured" });
      expect(result.snapshot.preferences.preferredThreadId).toBe(threadId);
    }
  });

  it("rejects unauthorized or invalid calls before reaching persistence", async () => {
    const reads = dependencies();
    const invalidContext = { ...context, role: "unknown" as SecurityContext["role"] };
    await expect(getCompanionPreferences(invalidContext, reads)).rejects.toMatchObject({ status: 403 });
    await expect(saveCompanionPreferences(invalidContext, {}, "save-a", reads)).rejects.toMatchObject({ status: 403 });
    await expect(saveCompanionPreferences(context, { action: "reset", expectedRevision: 0, actorId: "other" }, "save-a", reads)).rejects.toMatchObject({ status: 400 });
    expect(reads.read).not.toHaveBeenCalled();
    expect(reads.change).not.toHaveBeenCalled();
  });
});
