import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityContext } from "@/lib/security/types";
import { changeResponsibilityDraft, createResponsibilityDraft, getResponsibilityDraft, listResponsibilityDrafts, type ResponsibilityDependencies } from "./service";
import { prepareResponsibilityChange, ResponsibilityError, responsibilityId, reviewPreview } from "./state";
import { draftFixture as draft, nowFixture as now, ownerFixture as owner, pinsFixture as pins } from "./test-fixtures";
const context: SecurityContext = { tenantId: owner.tenantId, actorId: "owner@example.test", role: "operator", source: "session",
  auth: { userId: owner.actorId.slice(6), email: "owner@example.test", sessionId: "session-a", tenantName: "Fixture" } };
const id = responsibilityId(owner, "create");
const first = prepareResponsibilityChange({ owner, id, key: "create", now, mutation: { action: "create", expectedRevision: 0, draft } });
let deps: ResponsibilityDependencies;
beforeEach(() => { deps = { list: vi.fn().mockResolvedValue({ records: [first.current], hasMore: true }), read: vi.fn().mockResolvedValue(first.current), replay: vi.fn().mockResolvedValue(undefined), change: vi.fn().mockResolvedValue(first), pins: vi.fn().mockResolvedValue(pins), now: () => now }; });

describe("Responsibility service admission", () => {
  it("uses the canonical signed-in owner and reports bounded coverage without an invented total", async () => {
    const result = await listResponsibilityDrafts(context, 40, deps);
    expect(deps.list).toHaveBeenCalledExactlyOnceWith(owner, 40);
    expect(result.coverage).toEqual({ kind: "bounded_recent", limit: 40, returned: 1, total: null });
    expect(result.compatibility.activationSupported).toBe(false);
  });
  it("allows owned reads but refuses viewer mutations and an unbound session before storage", async () => {
    await expect(listResponsibilityDrafts({ ...context, role: "viewer" }, 40, deps)).resolves.toBeDefined();
    await expect(createResponsibilityDraft({ ...context, role: "viewer" }, { action: "create", expectedRevision: 0, draft }, "create", deps)).rejects.toMatchObject({ status: 403 });
    await expect(listResponsibilityDrafts({ ...context, auth: undefined }, 40, deps)).rejects.toMatchObject({ code: "responsibility_owner_unbound" });
    expect(deps.change).not.toHaveBeenCalled();
  });
  it("ordinary GET never resolves or mutates selected references", async () => {
    const result = await getResponsibilityDraft(context, id, false, deps);
    expect(result.readiness.state).toBe("not_checked");
    expect(deps.pins).not.toHaveBeenCalled(); expect(deps.change).not.toHaveBeenCalled();
  });
  it("returns explicit incomplete/blocked review reads and keeps transient failures separate", async () => {
    vi.mocked(deps.read).mockResolvedValue({ ...first.current, draft: { ...draft, sources: [] } });
    expect((await getResponsibilityDraft(context, id, true, deps)).readiness).toEqual({ state: "incomplete", issues: ["sources_required"] });
    expect(deps.pins).not.toHaveBeenCalled();
    vi.mocked(deps.read).mockResolvedValue(first.current);
    vi.mocked(deps.pins).mockRejectedValueOnce(new ResponsibilityError("Unavailable", 409, "responsibility_reference_unavailable"));
    expect((await getResponsibilityDraft(context, id, true, deps)).readiness.state).toBe("blocked");
    vi.mocked(deps.pins).mockRejectedValueOnce(new Error("private database text"));
    await expect(getResponsibilityDraft(context, id, true, deps)).rejects.toMatchObject({ status: 503, code: "responsibility_review_unavailable" });
  });
  it("resolves live pins and freezes the exact preview for the CAS writer", async () => {
    const preview = reviewPreview(first.current, pins);
    const input = { action: "review" as const, expectedRevision: 1, draftSha256: preview.draftSha256, reviewSha256: preview.reviewSha256 };
    await changeResponsibilityDraft(context, id, input, "review", deps);
    expect(deps.pins).toHaveBeenCalledExactlyOnceWith(context, owner, first.current);
    expect(deps.change).toHaveBeenCalledExactlyOnceWith(owner, id, input, "review", preview);
  });
  it("settles an accepted replay independently of later unavailable references or read failures", async () => {
    vi.mocked(deps.replay).mockResolvedValue({ ...first, replayed: true });
    vi.mocked(deps.read).mockRejectedValue(new Error("later read failure"));
    vi.mocked(deps.pins).mockRejectedValue(new Error("revoked source"));
    const result = await changeResponsibilityDraft(context, id, { action: "review", expectedRevision: 1, draftSha256: first.current.draftSha256, reviewSha256: "a".repeat(64) }, "review", deps);
    expect(result.receipt).toEqual(first.receipt); expect(result.replayed).toBe(true);
    expect(deps.read).not.toHaveBeenCalled(); expect(deps.pins).not.toHaveBeenCalled(); expect(deps.change).not.toHaveBeenCalled();
  });
  it("rejects revision drift before reference reads and never accepts an activation command", async () => {
    await expect(changeResponsibilityDraft(context, id, { action: "review", expectedRevision: 2, draftSha256: first.current.draftSha256, reviewSha256: "a".repeat(64) }, "review", deps)).rejects.toMatchObject({ code: "responsibility_review_changed" });
    await expect(changeResponsibilityDraft(context, id, { action: "activate", expectedRevision: 1 }, "activate", deps)).rejects.toMatchObject({ status: 400 });
    expect(deps.pins).not.toHaveBeenCalled(); expect(deps.change).not.toHaveBeenCalled();
  });
});
