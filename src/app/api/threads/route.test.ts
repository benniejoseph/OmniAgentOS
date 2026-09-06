import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getOwnedThread: vi.fn(),
  listConversationSummaries: vi.fn(),
  listThreads: vi.fn(),
  listThreadTurns: vi.fn(),
  rebuildConversationSummaryHierarchy: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/threads/store", () => ({
  createThread: vi.fn(),
  getOwnedThread: routeMocks.getOwnedThread,
  listConversationSummaries: routeMocks.listConversationSummaries,
  listThreads: routeMocks.listThreads,
  listThreadTurns: routeMocks.listThreadTurns,
  rebuildConversationSummaryHierarchy:
    routeMocks.rebuildConversationSummaryHierarchy,
}));

import {
  GET as GETThread,
  POST as POSTThread,
} from "@/app/api/threads/[id]/route";
import { GET as GETThreads } from "@/app/api/threads/route";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "thread-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const context = {
  tenantId: "tenant-a",
  actorId,
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: authUserId,
    email: actorId,
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const requestActorBinding = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: [actorId],
  readableOwnerActorIds: [canonicalActorId, actorId],
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.getOwnedThread.mockReset();
  routeMocks.listConversationSummaries.mockReset().mockResolvedValue([]);
  routeMocks.listThreads.mockReset().mockResolvedValue([]);
  routeMocks.listThreadTurns.mockReset().mockResolvedValue([]);
  routeMocks.rebuildConversationSummaryHierarchy.mockReset().mockResolvedValue([]);
});

describe("request-bound thread routes", () => {
  it("passes the authenticated actor binding to the thread list", async () => {
    const response = await GETThreads(
      new Request("http://localhost/api/threads?limit=20"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.listThreads).toHaveBeenCalledWith(20, {
      tenantId: context.tenantId,
      actorId,
      requestActorBinding,
    });
  });

  it("resolves the owner before reading thread turns", async () => {
    routeMocks.getOwnedThread.mockResolvedValue({
      id: "thread-a",
      tenantId: context.tenantId,
      actorId,
      title: "Thread A",
      mode: "orchestrate",
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T12:00:00.000Z",
    });

    const response = await GETThread(
      new Request("http://localhost/api/threads/thread-a"),
      { params: Promise.resolve({ id: "thread-a" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.getOwnedThread).toHaveBeenCalledWith("thread-a", {
      tenantId: context.tenantId,
      actorId,
      requestActorBinding,
    });
    expect(routeMocks.listThreadTurns).toHaveBeenCalledWith("thread-a", {
      tenantId: context.tenantId,
      limit: 40,
    });
    expect(routeMocks.listConversationSummaries).toHaveBeenCalledWith(
      "thread-a",
      { tenantId: context.tenantId, levels: ["episode"], limit: 100 },
    );
    expect(routeMocks.getOwnedThread.mock.invocationCallOrder[0]).toBeLessThan(
      routeMocks.listThreadTurns.mock.invocationCallOrder[0],
    );
  });

  it("does not read turns when the owner-scoped thread is absent", async () => {
    routeMocks.getOwnedThread.mockResolvedValue(null);

    const response = await GETThread(
      new Request("http://localhost/api/threads/missing"),
      { params: Promise.resolve({ id: "missing" }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.listThreadTurns).not.toHaveBeenCalled();
    expect(routeMocks.listConversationSummaries).not.toHaveBeenCalled();
  });

  it("rebuilds only an owner-scoped hierarchy and removes actor coordinates", async () => {
    routeMocks.getOwnedThread.mockResolvedValue({
      id: "thread-a",
      tenantId: context.tenantId,
      actorId,
      title: "Thread A",
      mode: "orchestrate",
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T12:00:00.000Z",
    });
    routeMocks.rebuildConversationSummaryHierarchy.mockResolvedValue([
      summaryRecord(),
    ]);

    const response = await POSTThread(
      new Request("http://localhost/api/threads/thread-a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "rebuild_summaries" }),
      }),
      { params: Promise.resolve({ id: "thread-a" }) },
    );

    expect(response.status).toBe(200);
    expect(routeMocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "write.memory",
      resourceType: "conversation_summary",
      resourceId: "thread-a",
    }));
    expect(routeMocks.rebuildConversationSummaryHierarchy).toHaveBeenCalledWith(
      "thread-a",
      { tenantId: context.tenantId, actorId },
    );
    const payload = await response.json();
    expect(payload.summaries[0]).not.toHaveProperty("actorId");
    expect(payload.summaries[0].accessScope).not.toHaveProperty("tenantId");
    expect(payload.summaries[0].accessScope).not.toHaveProperty("actorId");
  });
});

function summaryRecord() {
  return {
    id: "summary-a",
    tenantId: context.tenantId,
    actorId,
    level: "episode",
    bucketIndex: 0,
    threadId: "thread-a",
    content: "Episode summary",
    sourceTurnIds: ["turn-a"],
    childSummaryIds: ["turn-summary-a"],
    sourceSha256: "a".repeat(64),
    summarySha256: "b".repeat(64),
    accessScope: {
      schemaVersion: 1,
      visibility: "user_private",
      tenantId: context.tenantId,
      actorId,
      threadId: "thread-a",
      projectId: null,
      purposeIds: ["conversation.context.compile.v1"],
      scopeSha256: "c".repeat(64),
    },
    startsAt: "2026-09-04T10:00:00.000Z",
    endsAt: "2026-09-04T11:00:00.000Z",
    rebuildable: true,
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
  };
}
