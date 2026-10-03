import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalQueueItem } from "@/lib/operations/queue";
import type { AgentRunContinuation, AgentRunRecord } from "@/lib/runs/types";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import type { PersonalNotification } from "@/lib/today/types";
import {
  getActivity, parseActivityQuery,
  type ActivityReadDependencies, type ActivityScope,
} from "@/lib/activity/service";

const stores = vi.hoisted(() => ({
  listAgentRuns: vi.fn(), getOwnedThread: vi.fn(), getApprovalQueue: vi.fn(),
  listNotifications: vi.fn(), getNotificationCenter: vi.fn(),
}));
vi.mock("@/lib/runs/store", () => ({ listAgentRuns: stores.listAgentRuns }));
vi.mock("@/lib/threads/store", () => ({ getOwnedThread: stores.getOwnedThread }));
vi.mock("@/lib/operations/queue", () => ({ getApprovalQueue: stores.getApprovalQueue }));
vi.mock("@/lib/today/notifications", () => ({
  listNotifications: stores.listNotifications, getNotificationCenter: stores.getNotificationCenter,
}));

const at = "2026-10-03T10:00:00.000Z";
const scope: ActivityScope = { tenantId: "tenant-a", actorId: "owner@example.test", role: "operator", canReadApprovals: true };
const query = { group: "all" as const, limit: 25 };
const authUserId = "11111111-1111-4111-8111-111111111111";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1, kind: "auth_user", authUserId, canonicalActorId,
  legacyOwnerActorIds: [scope.actorId], readableOwnerActorIds: [canonicalActorId, scope.actorId],
};

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-a", tenantId: scope.tenantId, ownerActorId: scope.actorId,
    mode: "execute", status: "running", prompt: "PRIVATE_PROMPT", messages: [],
    response: "PRIVATE_OUTPUT", error: "PRIVATE_ERROR", memoryContextCount: 0, startedAt: at, ...overrides,
  };
}
function pausedRun(id: string, executionId: string, overrides: Partial<AgentRunRecord> = {}) {
  return run({
    id, status: "waiting_approval", continuation: {
      conversationItems: [], instructions: "PRIVATE_INSTRUCTIONS", response: "PRIVATE_RESPONSE",
      toolSteps: 1, outputsBeforeApproval: [], pendingToolCall: { callId: "call-a", toolId: "tool-a", toolName: "PRIVATE_TOOL", executionId },
      context: { tenantId: scope.tenantId, actorId: scope.actorId, role: scope.role }, createdAt: at,
    }, ...overrides,
  });
}
function approval(id = "approval-a", tenantId = scope.tenantId): ApprovalQueueItem {
  return {
    kind: "tool", id, tenantId, status: "approval_required", createdAt: at,
    title: "PRIVATE_TITLE", requestedBy: "other-owner", reason: "PRIVATE_REASON",
    input: { private: "PRIVATE_INPUT" }, record: { tenantId, actorId: "other-owner" },
    origin: { runId: "PRIVATE_OTHER_RUN", threadId: "PRIVATE_OTHER_THREAD" },
  } as unknown as ApprovalQueueItem;
}
function notification(overrides: Partial<PersonalNotification> = {}): PersonalNotification {
  return {
    id: "notification-a", tenantId: scope.tenantId, actorId: scope.actorId, title: "PRIVATE_TITLE",
    kind: "reminder", sourceType: "today_item", sourceId: "today-a", occurrenceKey: "PRIVATE_OCCURRENCE",
    urgency: "overdue", status: "unread", dueAt: at, createdAt: at, updatedAt: at, ...overrides,
  };
}
function readers() {
  return {
    listRuns: vi.fn<ActivityReadDependencies["listRuns"]>().mockResolvedValue([]),
    getThread: vi.fn<ActivityReadDependencies["getThread"]>().mockImplementation(async (id, owner) => ({
      id, tenantId: owner.tenantId, actorId: owner.actorId,
    })),
    listApprovals: vi.fn<ActivityReadDependencies["listApprovals"]>().mockResolvedValue({ items: [] }),
    listNotifications: vi.fn<ActivityReadDependencies["listNotifications"]>().mockResolvedValue([]),
  };
}
const stale = { status: 409, code: "activity_cursor_stale" };
const invalid = { status: 400, code: "activity_request_invalid" };

describe("bounded Activity reads", () => {
  beforeEach(() => {
    for (const mock of Object.values(stores)) mock.mockReset();
    stores.listAgentRuns.mockResolvedValue([]);
    stores.getApprovalQueue.mockResolvedValue({ items: [] });
    stores.listNotifications.mockResolvedValue([]);
    stores.getNotificationCenter.mockRejectedValue(new Error("Reminder processing must not run"));
  });

  it("uses only direct read stores, with exact bounds and no notification-center processing", async () => {
    const result = await getActivity(scope, query);
    expect(result).toMatchObject({
      state: "ready", items: [], window: { bounded: true, limitPerSource: 100 },
      counts: { working: 0, needs_you: 0, updates: 0, history: 0 },
      page: { limit: 25, hasMore: false, nextCursor: null },
    });
    expect(stores.listAgentRuns).toHaveBeenCalledExactlyOnceWith(100, { tenantId: scope.tenantId });
    expect(stores.getApprovalQueue).toHaveBeenCalledExactlyOnceWith(100, { tenantId: scope.tenantId, actorId: scope.actorId });
    expect(stores.listNotifications).toHaveBeenCalledExactlyOnceWith(100, { tenantId: scope.tenantId, actorId: scope.actorId });
    expect(stores.getOwnedThread).not.toHaveBeenCalled();
    expect(stores.getNotificationCenter).not.toHaveBeenCalled();
  });

  it("does not read the approval source without manage.workflow permission", async () => {
    const reads = readers();
    const result = await getActivity({ ...scope, role: "viewer", canReadApprovals: false }, query, reads);
    expect(reads.listApprovals).not.toHaveBeenCalled();
    expect(result.coverage.approvals).toEqual({ state: "restricted", limit: 100, visibleCount: null, reason: "permission_required" });
    expect(result.coverage.runs).toMatchObject({ state: "ready", visibleCount: 0 });
    expect(result.state).toBe("partial");
  });

  it("filters exact tenant and owner before looking up threads or projecting any metadata", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue([
      run({ threadId: "owned-thread" }),
      run({ id: "PRIVATE_OTHER_ACTOR", ownerActorId: "other-owner", threadId: "PRIVATE_OTHER_THREAD" }),
      run({ id: "PRIVATE_OTHER_TENANT", tenantId: "tenant-b", threadId: "PRIVATE_TENANT_THREAD" }),
      run({ id: "PRIVATE_MISSING_TENANT", tenantId: undefined }),
    ]);
    reads.listNotifications.mockResolvedValue([
      notification(), notification({ id: "PRIVATE_OTHER_NOTIFICATION", actorId: "other-owner" }),
      notification({ id: "PRIVATE_OTHER_TENANT_NOTIFICATION", tenantId: "tenant-b" }),
    ]);
    const result = await getActivity(scope, query, reads);
    expect(result.items.map((item) => item.id)).toEqual(["run:run-a", "notification:notification-a"]);
    expect(reads.getThread).toHaveBeenCalledExactlyOnceWith("owned-thread", { tenantId: scope.tenantId, actorId: scope.actorId });
    expect(result.coverage.runs).toMatchObject({ state: "partial", visibleCount: 1, reason: "records_omitted" });
    expect(result.coverage.notifications).toMatchObject({ state: "partial", visibleCount: 1 });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("accepts only the exact validated canonical owner bridge and forwards it to owner reads", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue([
      run({ id: "canonical-run", ownerActorId: canonicalActorId, threadId: "canonical-thread" }), run(),
    ]);
    reads.listNotifications.mockResolvedValue([notification({ actorId: canonicalActorId })]);
    const result = await getActivity({ ...scope, requestActorBinding: binding }, query, reads);
    expect(result.items).toHaveLength(3);
    expect(reads.getThread).toHaveBeenCalledWith("canonical-thread", { tenantId: scope.tenantId, actorId: scope.actorId, requestActorBinding: binding });
    expect(reads.listNotifications).toHaveBeenCalledWith(100, { tenantId: scope.tenantId, actorId: scope.actorId, requestActorBinding: binding });
    const invalidBinding = { ...binding, readableOwnerActorIds: [...binding.readableOwnerActorIds, "other-owner"] };
    const restricted = await getActivity({ ...scope, requestActorBinding: invalidBinding }, query, reads);
    expect(restricted.items.map((item) => item.id)).toEqual(["run:run-a"]);
    expect(reads.listNotifications).toHaveBeenLastCalledWith(100, { tenantId: scope.tenantId, actorId: scope.actorId });
  });

  it("withholds an owned run if its thread is missing, inaccessible, mismatched, or unreadable", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue(["missing", "actor", "tenant", "id", "error"].map((id) => run({ id: `run-${id}`, threadId: id })));
    reads.getThread.mockImplementation(async (id) => {
      if (id === "missing") return null;
      if (id === "error") throw new Error("PRIVATE_THREAD_ERROR");
      return { id: id === "id" ? "different" : id, tenantId: id === "tenant" ? "tenant-b" : scope.tenantId, actorId: id === "actor" ? "other-owner" : scope.actorId };
    });
    const result = await getActivity(scope, query, reads);
    expect(result.items).toEqual([]);
    expect(result.coverage.runs).toMatchObject({ state: "partial", visibleCount: 0, reason: "records_omitted" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("bounds concurrent thread checks at four and reuses one ownership lookup per thread", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue(Array.from({ length: 10 }, (_, index) => run({ id: `run-${index}`, threadId: `thread-${index % 8}` })));
    let active = 0;
    let maximum = 0;
    reads.getThread.mockImplementation(async (id) => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active--;
      return { id, tenantId: scope.tenantId, actorId: scope.actorId };
    });
    const result = await getActivity(scope, query, reads);
    expect(result.items).toHaveLength(10);
    expect(reads.getThread).toHaveBeenCalledTimes(8);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
  });

  it("keeps permitted tenant approvals but strips another actor's claimed origin and private fields", async () => {
    const reads = readers();
    reads.listApprovals.mockResolvedValue({ items: [
      approval(), approval("foreign-tenant", "tenant-b"),
      { ...approval("mismatched-record"), record: { tenantId: "tenant-b" } } as ApprovalQueueItem,
    ] });
    const result = await getActivity(scope, query, reads);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: "approval:tool:approval-a", title: "Tool approval" });
    expect(result.items[0]).not.toHaveProperty("origin");
    expect(result.coverage.approvals).toMatchObject({ state: "partial", visibleCount: 1 });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    expect(JSON.stringify(result)).not.toContain("other-owner");
  });

  it("folds only the exact waiting-run approval and preserves the owned conversation link", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue([
      pausedRun("linked-run", "approval-a", { threadId: "owned-thread" }),
      pausedRun("unmatched-run", "approval-b"), run({ id: "running-run" }),
    ]);
    reads.listApprovals.mockResolvedValue({ items: [approval()] });
    const result = await getActivity(scope, query, reads);
    const linked = result.items.find((item) => item.source === "approvals");
    expect(linked).toMatchObject({
      workKey: "run:linked-run", origin: { runId: "linked-run", threadId: "owned-thread" },
      references: [{ kind: "approval", id: "approval-a", approvalKind: "tool" }, { kind: "run", id: "linked-run" }],
    });
    expect(new URL(linked!.origin!.href, "https://example.test").searchParams.get("thread")).toBe("owned-thread");
    expect(result.items.map((item) => item.id)).toEqual(["approval:tool:approval-a", "run:running-run", "run:unmatched-run"]);
    expect(result.counts).toEqual({ working: 1, needs_you: 2, updates: 0, history: 0 });
    expect(result.coverage.runs.visibleCount).toBe(3);
  });

  it("does not guess an origin when two different owned runs name the same approval", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue([pausedRun("run-a", "approval-a"), pausedRun("run-b", "approval-a")]);
    reads.listApprovals.mockResolvedValue({ items: [approval()] });
    const result = await getActivity(scope, query, reads);
    expect(result.items).toHaveLength(3);
    expect(result.items.find((item) => item.source === "approvals")).not.toHaveProperty("origin");
  });

  it("deduplicates identical IDs, drops conflicting IDs, and retains separate reminder occurrences", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue([run(), run(), run({ id: "conflict" }), run({ id: "conflict", status: "failed" })]);
    reads.listNotifications.mockResolvedValue([notification(), notification(), notification({ id: "notification-b", occurrenceKey: "another-occurrence" })]);
    const result = await getActivity(scope, query, reads);
    expect(result.items.map((item) => item.id)).toEqual(["run:run-a", "notification:notification-a", "notification:notification-b"]);
    expect(result.items.filter((item) => item.workKey === "today_item:today-a")).toHaveLength(2);
    expect(result.coverage.runs).toMatchObject({ state: "partial", visibleCount: 1 });
    expect(result.coverage.notifications).toMatchObject({ state: "ready", visibleCount: 2 });
  });

  it("does not fold a run whose duplicate rows disagree about the pending approval identity", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue([pausedRun("run-a", "approval-a"), pausedRun("run-a", "approval-b")]);
    reads.listApprovals.mockResolvedValue({ items: [approval()] });
    const result = await getActivity(scope, query, reads);
    expect(result.items.map((item) => item.id)).toEqual(["approval:tool:approval-a"]);
    expect(result.items[0]).not.toHaveProperty("origin");
    expect(result.coverage.runs.state).toBe("partial");
  });

  it("handles incomplete stored continuations without inventing an approval link or failing other rows", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue([
      run({ id: "incomplete", status: "waiting_approval", continuation: {} as AgentRunContinuation }),
      run({ id: "malformed-status", status: ["running"] as unknown as AgentRunRecord["status"] }),
    ]);
    reads.listApprovals.mockResolvedValue({ items: [approval()] });
    const result = await getActivity(scope, query, reads);
    expect(result.items.map((item) => item.id)).toEqual(["approval:tool:approval-a", "run:incomplete"]);
    expect(result.items[0]).not.toHaveProperty("origin");
    expect(result.coverage.runs).toMatchObject({ state: "partial", visibleCount: 1 });
  });

  it("distinguishes unavailable source reads from confirmed empty sources without exposing error details", async () => {
    const reads = readers();
    reads.listRuns.mockRejectedValue(new Error("PRIVATE_RUN_ERROR"));
    reads.listApprovals.mockRejectedValue(new Error("PRIVATE_APPROVAL_ERROR"));
    const partial = await getActivity(scope, query, reads);
    expect(partial.state).toBe("partial");
    expect(partial.coverage.runs).toEqual({ state: "unavailable", limit: 100, visibleCount: null, reason: "read_failed" });
    expect(partial.coverage.notifications).toEqual({ state: "ready", limit: 100, visibleCount: 0 });
    reads.listNotifications.mockRejectedValue(new Error("PRIVATE_NOTIFICATION_ERROR"));
    const unavailable = await getActivity(scope, query, reads);
    expect(unavailable.state).toBe("unavailable");
    expect(JSON.stringify(unavailable)).not.toContain("PRIVATE_");
  });

  it("enforces the 100-record source window even if a dependency returns an oversized list", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue(Array.from({ length: 101 }, (_, index) => run({ id: `run-${index}`, threadId: `thread-${index}` })));
    reads.listApprovals.mockResolvedValue({ items: Array.from({ length: 101 }, (_, index) => approval(`approval-${index}`)) });
    reads.listNotifications.mockResolvedValue(Array.from({ length: 101 }, (_, index) => notification({ id: `notification-${index}` })));
    const result = await getActivity(scope, { ...query, limit: 50 }, reads);
    expect(result.coverage.runs.visibleCount).toBe(100);
    expect(result.coverage.approvals.visibleCount).toBe(100);
    expect(result.coverage.notifications.visibleCount).toBe(100);
    expect(reads.getThread).toHaveBeenCalledTimes(100);
    expect(reads.getThread).not.toHaveBeenCalledWith("thread-100", expect.anything());
    expect(Object.values(result.counts).reduce((sum, count) => sum + count, 0)).toBe(300);
    expect(result.items).toHaveLength(50);
  });
});

describe("Activity cursor window", () => {
  it("pages a stable deduplicated order without changing the bounded window counts", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue(["f", "a", "c", "b", "d", "e", "a"].map((id) => run({ id: `run-${id}` })));
    const first = await getActivity(scope, { ...query, limit: 2 }, reads);
    const second = await getActivity(scope, { ...query, limit: 2, cursor: first.page.nextCursor! }, reads);
    const third = await getActivity(scope, { ...query, limit: 2, cursor: second.page.nextCursor! }, reads);
    expect([...first.items, ...second.items, ...third.items].map((item) => item.id)).toEqual(
      ["a", "b", "c", "d", "e", "f"].map((id) => `run:run-${id}`),
    );
    expect(first.counts).toEqual(second.counts);
    expect(second.counts).toEqual(third.counts);
    expect(third.page).toEqual({ limit: 2, hasMore: false, nextCursor: null });
    expect(reads.listRuns).toHaveBeenCalledTimes(3);
    expect(reads.listApprovals).toHaveBeenCalledTimes(3);
    expect(reads.listNotifications).toHaveBeenCalledTimes(3);
  });

  it("filters before paging while reporting counts for the whole readable window", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue([run(), run({ id: "run-b", status: "completed" }), run({ id: "run-c", status: "failed" })]);
    const first = await getActivity(scope, { group: "history", limit: 1 }, reads);
    const second = await getActivity(scope, { group: "history", limit: 1, cursor: first.page.nextCursor! }, reads);
    expect(first.items[0].id).toBe("run:run-b");
    expect(second.items[0].id).toBe("run:run-c");
    expect(second.counts).toEqual({ working: 1, needs_you: 0, updates: 0, history: 2 });
  });

  it("rejects cursor reuse across actor, tenant, role, capability, owner binding, group, or page size before source reads", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue([run(), run({ id: "run-b" })]);
    const first = await getActivity(scope, { ...query, limit: 1 }, reads);
    const cursor = first.page.nextCursor!;
    reads.listRuns.mockClear();
    for (const changed of [
      { ...scope, actorId: "other-owner" }, { ...scope, tenantId: "tenant-b" },
      { ...scope, role: "admin" as const }, { ...scope, canReadApprovals: false },
      { ...scope, requestActorBinding: binding },
    ]) await expect(getActivity(changed, { ...query, limit: 1, cursor }, reads)).rejects.toMatchObject(stale);
    await expect(getActivity(scope, { group: "working", limit: 1, cursor }, reads)).rejects.toMatchObject(stale);
    await expect(getActivity(scope, { ...query, limit: 2, cursor }, reads)).rejects.toMatchObject(stale);
    expect(reads.listRuns).not.toHaveBeenCalled();
  });

  it("invalidates a cursor when visible data or source availability changes", async () => {
    const reads = readers();
    const rows = [run(), run({ id: "run-b" })];
    reads.listRuns.mockResolvedValue(rows);
    const first = await getActivity(scope, { ...query, limit: 1 }, reads);
    const next = { ...query, limit: 1, cursor: first.page.nextCursor! };
    reads.listRuns.mockResolvedValue([run({ status: "completed" }), rows[1]]);
    await expect(getActivity(scope, next, reads)).rejects.toMatchObject(stale);
    reads.listRuns.mockResolvedValue(rows);
    reads.listNotifications.mockRejectedValue(new Error("PRIVATE_READ_FAILURE"));
    await expect(getActivity(scope, next, reads)).rejects.toMatchObject(stale);
  });

  it("rechecks owned thread access on every page and invalidates a revoked source", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue([run({ threadId: "thread-a" }), run({ id: "run-b" })]);
    const first = await getActivity(scope, { ...query, limit: 1 }, reads);
    reads.getThread.mockResolvedValue(null);
    await expect(getActivity(scope, { ...query, limit: 1, cursor: first.page.nextCursor! }, reads)).rejects.toMatchObject(stale);
    expect(reads.getThread).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed cursors and out-of-window offsets without treating them as authority", async () => {
    const reads = readers();
    reads.listRuns.mockResolvedValue([run(), run({ id: "run-b" })]);
    const first = await getActivity(scope, { ...query, limit: 1 }, reads);
    for (const cursor of ["not+base64", Buffer.from("{}").toString("base64url"), "a".repeat(2_001)]) {
      await expect(getActivity(scope, { ...query, limit: 1, cursor }, reads)).rejects.toMatchObject(invalid);
    }
    const decoded = JSON.parse(Buffer.from(first.page.nextCursor!, "base64url").toString("utf8"));
    const outside = Buffer.from(JSON.stringify({ ...decoded, offset: 99 })).toString("base64url");
    await expect(getActivity(scope, { ...query, limit: 1, cursor: outside }, reads)).rejects.toMatchObject(stale);
  });

  it("validates bounded query inputs without silently coercing duplicate or malformed parameters", () => {
    expect(parseActivityQuery(new URL("https://example.test/api/activity"))).toEqual(query);
    expect(parseActivityQuery(new URL("https://example.test/api/activity?group=needs_you&limit=50"))).toEqual({ group: "needs_you", limit: 50 });
    for (const search of ["group=unknown", "limit=0", "limit=51", "limit=1.5", "limit=01", "limit=1&limit=2", "group=all&group=working", "cursor=", "cursor=a&cursor=b"]) {
      expect(() => parseActivityQuery(new URL(`https://example.test/api/activity?${search}`))).toThrow("Activity parameters are invalid");
    }
  });
});
