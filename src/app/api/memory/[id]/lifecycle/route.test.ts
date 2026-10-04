import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MemoryLifecycleConflictError extends Error {}
  return {
    MemoryLifecycleConflictError,
    authorize: vi.fn(),
    getMemory: vi.fn(),
    setLifecycle: vi.fn(),
    readTarget: vi.fn(),
    submitMutation: vi.fn(),
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
vi.mock("@/lib/memory/lifecycle-mutation-store", () => ({
  readMemoryLifecycleTarget: mocks.readTarget,
  submitMemoryLifecycleMutation: mocks.submitMutation,
}));

import { GET, PATCH } from "@/app/api/memory/[id]/lifecycle/route";
import { MemoryLifecycleMutationError } from "@/lib/memory/lifecycle-mutation-contracts";

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
        headers: { "content-type": "application/json", "idempotency-key": "lifecycle-pin" },
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
        headers: { "content-type": "application/json", "idempotency-key": "lifecycle-extra-field" },
        body: JSON.stringify({ action: "pin", memoryId: "memory-b" }),
      },
    ), { params: Promise.resolve({ id: "memory-a" }) });

    expect(response.status).toBe(400);
    expect(mocks.setLifecycle).not.toHaveBeenCalled();
  });

  it("reads a fresh owner-bound lifecycle target without admitting a mutation", async () => {
    const current = { contract: "asael-memory-lifecycle-read:1", target: { memoryId: "memory-a", token: "a".repeat(64) } };
    mocks.readTarget.mockResolvedValue(current);
    const response = await GET(new Request("http://localhost/api/memory/memory-a/lifecycle"), { params: Promise.resolve({ id: "memory-a" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).current).toEqual(current);
    expect(mocks.readTarget).toHaveBeenCalledWith(expect.objectContaining({ ownerActorId: `actor:${context.auth.userId}` }), "memory-a");
    expect(mocks.submitMutation).not.toHaveBeenCalled();
  });

  it("retains accepted effect evidence when the independent current-record read fails", async () => {
    const acceptance = { id: "accepted-exact-target", memoryId: "memory-a" };
    mocks.submitMutation.mockResolvedValue({ acceptance, replayed: false, current: { target: { memoryId: "memory-a" } } });
    mocks.getMemory.mockReset().mockRejectedValue(new Error("current read unavailable"));
    const request = { contract: "asael-memory-lifecycle-mutation:1", action: "pin", expectedTargetToken: "a".repeat(64) };
    const response = await PATCH(new Request("http://localhost/api/memory/memory-a/lifecycle", {
      method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": "exact-lifecycle" }, body: JSON.stringify(request),
    }), { params: Promise.resolve({ id: "memory-a" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ acceptance, currentRecord: { state: "unavailable" } });
    expect(mocks.submitMutation).toHaveBeenCalledWith(expect.objectContaining({ memoryId: "memory-a", idempotencyKey: "exact-lifecycle", request }));
    expect(mocks.setLifecycle).not.toHaveBeenCalled();
  });

  it("preserves precise stale-target conflicts without implying a successful write", async () => {
    mocks.submitMutation.mockRejectedValue(new MemoryLifecycleMutationError("memory_lifecycle_target_changed", 409, "Read current state."));
    const response = await PATCH(new Request("http://localhost/api/memory/memory-a/lifecycle", {
      method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": "exact-lifecycle" },
      body: JSON.stringify({ contract: "asael-memory-lifecycle-mutation:1", action: "pin", expectedTargetToken: "a".repeat(64) }),
    }), { params: Promise.resolve({ id: "memory-a" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "memory_lifecycle_target_changed" });
    expect(mocks.setLifecycle).not.toHaveBeenCalled();
  });

  it("does not invent canonical authority for an unbound human request", async () => {
    mocks.authorize.mockResolvedValue({ ...context, actorId: "different@example.test" });
    const response = await GET(new Request("http://localhost/api/memory/memory-a/lifecycle"), { params: Promise.resolve({ id: "memory-a" }) });
    expect(response.status).toBe(403);
    expect(mocks.readTarget).not.toHaveBeenCalled();
  });

  it("bounds malformed path and query reads privately before touching storage", async () => {
    for (const [path, id] of [["memory%ZZ", "memory%ZZ"], ["memory-a?extra=1", "memory-a"]]) {
      const response = await GET(new Request(`http://localhost/api/memory/${path.replace("?extra=1", "")}/lifecycle${path.includes("?") ? "?extra=1" : ""}`), { params: Promise.resolve({ id }) });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.readTarget).not.toHaveBeenCalled();
  });
});
