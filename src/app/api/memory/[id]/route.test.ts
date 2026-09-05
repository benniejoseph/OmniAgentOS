import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  class MemoryDeletionPreviewConflictError extends Error {
    constructor() {
      super("Memory deletion impact changed. Review a fresh preview before forgetting it.");
      this.name = "MemoryDeletionPreviewConflictError";
    }
  }
  return {
    MemoryDeletionPreviewConflictError,
    authorizeRequest: vi.fn(),
    executionScopeFromSecurityContext: vi.fn(),
    forgetMemoryWithReceipt: vi.fn(),
    previewMemoryDeletion: vi.fn(),
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/security/execution-scope", () => ({
  executionScopeFromSecurityContext:
    routeMocks.executionScopeFromSecurityContext,
}));

vi.mock("@/lib/memory/store", () => ({
  MemoryDeletionPreviewConflictError:
    routeMocks.MemoryDeletionPreviewConflictError,
  correctMemory: vi.fn(),
  forgetMemoryWithReceipt: routeMocks.forgetMemoryWithReceipt,
  getMemory: vi.fn(),
  previewMemoryDeletion: routeMocks.previewMemoryDeletion,
}));

vi.mock("@/lib/memory/graph", () => ({
  queueMemoryGraphRebuild: vi.fn(),
}));

vi.mock("@/lib/openai/client", () => ({ embedTexts: vi.fn() }));

import { DELETE, GET } from "@/app/api/memory/[id]/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
};
const preview = {
  schemaVersion: 1,
  contractKind: "memory_deletion_preview",
  state: "ready",
  guarantee: "rollback_proof_barrier",
  memory: { id: "memory-a", title: "Memory A", type: "fact" },
  descendantMemories: [],
  impact: {
    rootMemoryCount: 1,
    descendantMemoryCount: 0,
    retrievalTraceCount: 2,
    graphNodeCount: 1,
    graphEdgeCount: 1,
    pendingAgentRunCount: 1,
    pendingWorkflowRunCount: 0,
  },
  expectedReceiptManifestSha256: "a".repeat(64),
  generatedAt: "2026-09-05T00:00:00.000Z",
};

describe("memory deletion route", () => {
  beforeEach(() => {
    routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
    routeMocks.previewMemoryDeletion.mockReset().mockResolvedValue(preview);
    routeMocks.executionScopeFromSecurityContext.mockReset().mockReturnValue({
      tenantId: "tenant-a",
      initiatingActorId: "owner@example.test",
    });
    routeMocks.forgetMemoryWithReceipt.mockReset().mockResolvedValue({
      memory: { id: "memory-a" },
      receipt: null,
      deletionGuarantee: "best_effort",
      deletionDisposition: "committed",
      invalidatedAgentRunCount: 0,
      invalidatedWorkflowRunCount: 0,
    });
  });

  it("requires write authority and returns a no-store exact preview", async () => {
    const response = await GET(
      new Request("http://localhost/api/memory/memory-a?view=deletion-preview"),
      { params: Promise.resolve({ id: "memory-a" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "write.memory",
      resourceId: "memory-a",
    }));
    expect(routeMocks.previewMemoryDeletion).toHaveBeenCalledWith("memory-a", {
      tenantId: "tenant-a",
    });
  });

  it("refuses deletion without the reviewed preview digest", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/memory/memory-a", { method: "DELETE" }),
      { params: Promise.resolve({ id: "memory-a" }) },
    );

    expect(response.status).toBe(428);
    expect(routeMocks.forgetMemoryWithReceipt).not.toHaveBeenCalled();
  });

  it("binds deletion to the reviewed preview digest", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/memory/memory-a", {
        method: "DELETE",
        headers: { "x-asael-deletion-preview": "a".repeat(64) },
      }),
      { params: Promise.resolve({ id: "memory-a" }) },
    );

    expect(response.status).toBe(200);
    expect(routeMocks.forgetMemoryWithReceipt).toHaveBeenCalledWith(
      "memory-a",
      expect.objectContaining({
        tenantId: "tenant-a",
        expectedDescendantManifestSha256: "a".repeat(64),
      }),
    );
  });

  it("requires a new preview when deletion impact changes", async () => {
    routeMocks.forgetMemoryWithReceipt.mockRejectedValue(
      new routeMocks.MemoryDeletionPreviewConflictError(),
    );
    const response = await DELETE(
      new Request("http://localhost/api/memory/memory-a", {
        method: "DELETE",
        headers: { "x-asael-deletion-preview": "a".repeat(64) },
      }),
      { params: Promise.resolve({ id: "memory-a" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("fresh preview"),
    });
  });
});
