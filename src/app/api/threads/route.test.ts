import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getOwnedThread: vi.fn(),
  listThreads: vi.fn(),
  listThreadTurns: vi.fn(),
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
  listThreads: routeMocks.listThreads,
  listThreadTurns: routeMocks.listThreadTurns,
}));

import { GET as GETThread } from "@/app/api/threads/[id]/route";
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
  routeMocks.listThreads.mockReset().mockResolvedValue([]);
  routeMocks.listThreadTurns.mockReset().mockResolvedValue([]);
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
  });
});
