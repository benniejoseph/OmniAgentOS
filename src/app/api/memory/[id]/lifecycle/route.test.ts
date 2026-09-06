import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MemoryLifecycleConflictError extends Error {}
  return {
    MemoryLifecycleConflictError,
    authorize: vi.fn(),
    getMemory: vi.fn(),
    setLifecycle: vi.fn(),
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorize,
  forbiddenResponse: (error: unknown) => Response.json({ error }, { status: 403 }),
}));
vi.mock("@/lib/memory/store", () => ({ getMemory: mocks.getMemory }));
vi.mock("@/lib/memory/maintenance-store", () => ({
  MemoryLifecycleConflictError: mocks.MemoryLifecycleConflictError,
  setMemoryLifecycle: mocks.setLifecycle,
}));

import { PATCH } from "@/app/api/memory/[id]/lifecycle/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const memory = {
  id: "memory-a",
  tenantId: "tenant-a",
  type: "fact" as const,
  title: "Pinned fact",
  content: "Keep this easy to recall.",
  tags: [],
  scope: "workspace" as const,
  source: "manual",
  importance: 0.8,
  claimStatus: "active" as const,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};

describe("memory lifecycle API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue(context);
    mocks.getMemory.mockResolvedValueOnce(null).mockResolvedValue(memory);
    mocks.setLifecycle.mockResolvedValue({
      memoryId: "memory-a",
      pinnedAt: "2026-09-06T00:01:00.000Z",
    });
  });

  it("applies a strict reversible lifecycle action", async () => {
    const response = await PATCH(new Request(
      "http://localhost/api/memory/memory-a/lifecycle",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pin" }),
      },
    ), { params: Promise.resolve({ id: "memory-a" }) });

    expect(response.status).toBe(200);
    expect(mocks.setLifecycle).toHaveBeenCalledWith(
      memory,
      "pin",
      expect.objectContaining({ tenantId: "tenant-a" }),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects fields outside the lifecycle action contract", async () => {
    const response = await PATCH(new Request(
      "http://localhost/api/memory/memory-a/lifecycle",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pin", memoryId: "memory-b" }),
      },
    ), { params: Promise.resolve({ id: "memory-a" }) });

    expect(response.status).toBe(400);
    expect(mocks.setLifecycle).not.toHaveBeenCalled();
  });
});
