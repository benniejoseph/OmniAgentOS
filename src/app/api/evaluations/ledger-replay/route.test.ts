import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecurityPolicyError } from "@/lib/security/context";
import type { AgentRunRecord } from "@/lib/runs/types";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  listAgentRuns: vi.fn(),
  listAgentRunEventsAfter: vi.fn(),
  recordRuntimeEventSafely: vi.fn(),
  getOwnedThread: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorizeRequest,
}));
vi.mock("@/lib/runs/store", () => ({
  listAgentRuns: mocks.listAgentRuns,
  listAgentRunEventsAfter: mocks.listAgentRunEventsAfter,
}));
vi.mock("@/lib/observability/store", () => ({
  recordRuntimeEventSafely: mocks.recordRuntimeEventSafely,
}));
vi.mock("@/lib/threads/store", () => ({
  getOwnedThread: mocks.getOwnedThread,
}));

import { GET } from "@/app/api/evaluations/ledger-replay/route";

const GOAL = "Summarize this week's project notes.";

function run(id: string, startedAt: string): AgentRunRecord {
  return {
    id,
    tenantId: "tenant-a",
    ownerActorId: "owner-a",
    mode: "research",
    status: "completed",
    prompt: GOAL,
    messages: [{ role: "user", content: GOAL }],
    memoryContextCount: 0,
    response: "A summary of the notes.",
    startedAt,
    completedAt: startedAt,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
  mocks.authorizeRequest.mockReset().mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "owner-a",
    role: "viewer",
    source: "session",
  });
  mocks.listAgentRuns.mockReset().mockResolvedValue([
    run("run-recent", "2026-09-30T12:00:00.000Z"),
    run("run-month", "2026-09-05T12:00:00.000Z"),
  ]);
  mocks.listAgentRunEventsAfter.mockReset().mockResolvedValue([{
    id: "event-model",
    runId: "run-recent",
    type: "model",
    payload: { type: "model", provider: "openai", estimatedCostUsd: 0.01 },
    createdAt: "2026-09-30T12:00:00.000Z",
  }]);
  mocks.recordRuntimeEventSafely.mockReset().mockResolvedValue(undefined);
  mocks.getOwnedThread.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ledger-replay export route", () => {
  it("exports the tenant's replay corpus as a private download", async () => {
    const response = await GET(new Request(
      "http://asael.test/api/evaluations/ledger-replay",
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition"))
      .toBe('attachment; filename="ledger-replay-2026-10-01.json"');
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "agent_run",
    }));
    expect(mocks.listAgentRuns).toHaveBeenCalledWith(200, { tenantId: "tenant-a" });
    expect(mocks.listAgentRunEventsAfter).toHaveBeenCalledWith("run-recent", {
      tenantId: "tenant-a",
      limit: 500,
    });
    // The default window is a week, so the older run is not read.
    expect(mocks.listAgentRunEventsAfter).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      kind: "ledger_replay",
      since: "2026-09-24T12:00:00.000Z",
      examined: 1,
      tasks: [{ id: "replay-run-recent", goal: GOAL }],
    });
    // The runtime event keeps counts, never the goals.
    expect(mocks.recordRuntimeEventSafely).toHaveBeenCalledWith({
      category: "evaluation",
      action: "evaluation.ledger_replay_exported",
      tenantId: "tenant-a",
      actorId: "owner-a",
      resourceType: "agent_run",
      message: "Exported 1 ledger-replay tasks.",
      metadata: { days: 7, limit: 20, examined: 1, taskCount: 1, skipped: {} },
    });
    expect(JSON.stringify(mocks.recordRuntimeEventSafely.mock.calls)).not.toContain(GOAL);
  });

  it("bounds the window and the task count", async () => {
    const response = await GET(new Request(
      "http://asael.test/api/evaluations/ledger-replay?days=90&limit=0",
    ));
    const body = await response.json();

    expect(body).toMatchObject({
      since: "2026-09-01T12:00:00.000Z",
      examined: 1,
      tasks: [expect.objectContaining({ id: expect.stringMatching(/^replay-run-/) })],
    });
    expect(mocks.recordRuntimeEventSafely).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ days: 30, limit: 1 }),
    }));
    const wide = await (await GET(new Request(
      "http://asael.test/api/evaluations/ledger-replay?days=30&limit=99",
    ))).json();
    // The order comes from a hash of this tenant and each run.
    expect(wide.tasks.map((task: { id: string }) => task.id))
      .toEqual(["replay-run-recent", "replay-run-month"]);
    expect(mocks.recordRuntimeEventSafely).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ days: 30, limit: 50 }),
    }));
  });

  it.each(["viewer", "admin"])("exports only the caller's runs for a %s", async (role) => {
    mocks.authorizeRequest.mockResolvedValue({
      tenantId: "tenant-a", actorId: "owner-a", role, source: "session",
    });
    mocks.listAgentRuns.mockResolvedValue([
      run("run-owned", "2026-09-30T12:00:00.000Z"),
      { ...run("run-other", "2026-09-30T12:00:00.000Z"), ownerActorId: "owner-b" },
    ]);

    const body = await (await GET(new Request(
      "http://asael.test/api/evaluations/ledger-replay",
    ))).json();

    expect(body).toMatchObject({
      examined: 1,
      skipped: {},
      tasks: [{ id: "replay-run-owned" }],
    });
    expect(mocks.listAgentRunEventsAfter).toHaveBeenCalledTimes(1);
    expect(mocks.listAgentRunEventsAfter).toHaveBeenCalledWith("run-owned", {
      tenantId: "tenant-a", limit: 500,
    });
    expect(JSON.stringify(mocks.recordRuntimeEventSafely.mock.calls)).not.toContain("run-other");
  });

  it("requires an owned parent thread before reading a thread-linked run", async () => {
    mocks.listAgentRuns.mockResolvedValue([
      { ...run("run-owned-thread", "2026-09-30T12:00:00.000Z"), threadId: "thread-owned" },
      { ...run("run-unreadable-thread", "2026-09-30T12:00:00.000Z"), threadId: "thread-unreadable" },
    ]);
    mocks.getOwnedThread.mockImplementation(async (id: string) =>
      id === "thread-owned" ? { id, actorId: "owner-a" } : null
    );

    const body = await (await GET(new Request(
      "http://asael.test/api/evaluations/ledger-replay",
    ))).json();

    expect(body).toMatchObject({ examined: 1, tasks: [{ id: "replay-run-owned-thread" }] });
    expect(mocks.getOwnedThread).toHaveBeenCalledWith("thread-unreadable", {
      tenantId: "tenant-a", actorId: "owner-a", requestActorBinding: undefined,
    });
    expect(mocks.listAgentRunEventsAfter).toHaveBeenCalledTimes(1);
    expect(mocks.listAgentRunEventsAfter).toHaveBeenCalledWith("run-owned-thread", {
      tenantId: "tenant-a", limit: 500,
    });
  });

  it("recognizes only the server-derived canonical and current actor pair", async () => {
    const userId = "11111111-2222-4333-8444-555555555555";
    const actorId = "owner@example.test";
    const canonicalActorId = `actor:${userId}`;
    mocks.authorizeRequest.mockResolvedValue({
      tenantId: "tenant-a", actorId, role: "viewer", source: "session",
      auth: { userId, email: actorId, sessionId: "session-a", tenantName: "Test" },
    });
    mocks.listAgentRuns.mockResolvedValue([
      { ...run("run-current", "2026-09-30T12:00:00.000Z"), ownerActorId: actorId },
      {
        ...run("run-canonical", "2026-09-30T12:00:00.000Z"),
        ownerActorId: canonicalActorId,
        threadId: "thread-canonical",
      },
      { ...run("run-unrelated", "2026-09-30T12:00:00.000Z"), ownerActorId: "prior@example.test" },
    ]);
    mocks.getOwnedThread.mockResolvedValue({ id: "thread-canonical", actorId });

    const body = await (await GET(new Request(
      "http://asael.test/api/evaluations/ledger-replay",
    ))).json();

    expect(body.examined).toBe(2);
    expect(body.tasks.map((task: { id: string }) => task.id).sort())
      .toEqual(["replay-run-canonical", "replay-run-current"]);
    expect(mocks.getOwnedThread).toHaveBeenCalledWith("thread-canonical", {
      tenantId: "tenant-a", actorId,
      requestActorBinding: {
        version: 1, kind: "auth_user", authUserId: userId, canonicalActorId,
        legacyOwnerActorIds: [actorId], readableOwnerActorIds: [canonicalActorId, actorId],
      },
    });
    expect(mocks.listAgentRunEventsAfter).toHaveBeenCalledTimes(2);
  });

  it("refuses a caller who cannot read runs", async () => {
    mocks.authorizeRequest.mockRejectedValue(
      new SecurityPolicyError("Authentication required.", 401),
    );

    const response = await GET(new Request(
      "http://asael.test/api/evaluations/ledger-replay",
    ));

    expect(response.status).toBe(401);
    expect(mocks.listAgentRuns).not.toHaveBeenCalled();
    expect(mocks.recordRuntimeEventSafely).not.toHaveBeenCalled();
  });
});
