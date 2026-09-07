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
    correctMemory: vi.fn(),
    getMemory: vi.fn(),
    getMemoryDeletionReceipt: vi.fn(),
    indexUserPrivateMemoryGraphRecords: vi.fn(),
    queueMemoryGraphRebuild: vi.fn(),
    embedTexts: vi.fn(),
    projectExplicitMemoryEntities: vi.fn(),
    retireEntityMemoryLineage: vi.fn(),
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

vi.mock("@/lib/security/execution-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/execution-scope")>()),
  executionScopeFromSecurityContext:
    routeMocks.executionScopeFromSecurityContext,
}));

vi.mock("@/lib/memory/store", () => ({
  MemoryDeletionPreviewConflictError:
    routeMocks.MemoryDeletionPreviewConflictError,
  correctMemory: routeMocks.correctMemory,
  forgetMemoryWithReceipt: routeMocks.forgetMemoryWithReceipt,
  getMemory: routeMocks.getMemory,
  getMemoryDeletionReceipt: routeMocks.getMemoryDeletionReceipt,
  previewMemoryDeletion: routeMocks.previewMemoryDeletion,
}));

vi.mock("@/lib/memory/graph", () => ({
  indexUserPrivateMemoryGraphRecords:
    routeMocks.indexUserPrivateMemoryGraphRecords,
  queueMemoryGraphRebuild: routeMocks.queueMemoryGraphRebuild,
}));

vi.mock("@/lib/openai/client", () => ({
  embedTexts: routeMocks.embedTexts,
}));

vi.mock("@/lib/entities/extraction", () => ({
  projectExplicitMemoryEntities: routeMocks.projectExplicitMemoryEntities,
}));

vi.mock("@/lib/entities/store", () => ({
  retireEntityMemoryLineage: routeMocks.retireEntityMemoryLineage,
}));

import { DELETE, GET, PATCH } from "@/app/api/memory/[id]/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
};
const authenticatedContext = {
  ...context,
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
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
    routeMocks.correctMemory.mockReset();
    routeMocks.getMemory.mockReset();
    routeMocks.getMemoryDeletionReceipt.mockReset().mockResolvedValue(null);
    routeMocks.indexUserPrivateMemoryGraphRecords.mockReset();
    routeMocks.queueMemoryGraphRebuild.mockReset();
    routeMocks.embedTexts.mockReset().mockResolvedValue([]);
    routeMocks.projectExplicitMemoryEntities.mockReset();
    routeMocks.retireEntityMemoryLineage.mockReset();
    routeMocks.executionScopeFromSecurityContext.mockReset().mockReturnValue({
      version: 1,
      tenantId: "tenant-a",
      initiatingActorId: "owner@example.test",
      executingPrincipalType: "user",
      executingPrincipalId: "owner@example.test",
      workspaceId: null,
      projectId: null,
      missionId: null,
      delegationId: null,
      correlationId: "memory-route-test",
      causationId: "memory-a",
      contextGrantIds: [],
      capabilityGrantIds: [],
      purpose: "api.memory.test",
    });
    routeMocks.forgetMemoryWithReceipt.mockReset().mockResolvedValue({
      memory: { id: "memory-a" },
      receipt: null,
      deletionGuarantee: "best_effort",
      deletionDisposition: "committed",
      invalidatedAgentRunCount: 0,
      invalidatedWorkflowRunCount: 0,
      invalidatedDailyBriefCount: 0,
      affectedEntityCount: 1,
      retiredEntityCount: 1,
      retiredEntityAliasCount: 0,
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
    await expect(response.json()).resolves.toMatchObject({
      affectedEntityCount: 1,
      retiredEntityCount: 1,
      retiredEntityAliasCount: 0,
    });
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

  it("uses the canonical private scope for an authenticated deletion", async () => {
    routeMocks.authorizeRequest.mockResolvedValue(authenticatedContext);
    const response = await DELETE(
      new Request("http://localhost/api/memory/memory-a", {
        method: "DELETE",
        headers: { "x-asael-deletion-preview": "a".repeat(64) },
      }),
      { params: Promise.resolve({ id: "memory-a" }) },
    );

    expect(response.status).toBe(200);
    expect(routeMocks.forgetMemoryWithReceipt).toHaveBeenCalledTimes(1);
    expect(routeMocks.forgetMemoryWithReceipt).toHaveBeenCalledWith(
      "memory-a",
      expect.objectContaining({
        executionScope: expect.objectContaining({
          initiatingActorId:
            "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
        }),
        accessScope: expect.objectContaining({
          purposeId: "memory.forget.v1",
        }),
      }),
    );
  });

  it("holds a contradiction candidate out of graph and entity projections", async () => {
    const existing = {
      id: "memory-a",
      tenantId: "tenant-a",
      type: "fact",
      title: "Office day",
      content: "Tuesday",
      tags: [],
      scope: "workspace",
      source: "manual",
      importance: 0.8,
      claimStatus: "active",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    };
    const candidate = {
      ...existing,
      id: "memory-b",
      content: "Thursday",
      claimStatus: "candidate",
      contradictionOfId: "memory-a",
    };
    routeMocks.getMemory.mockResolvedValue(existing);
    routeMocks.correctMemory.mockResolvedValue({
      previous: existing,
      corrected: candidate,
      review: {
        id: "review-a",
        tenantId: "tenant-a",
        kind: "contradiction",
        status: "pending",
        detectionReason: "explicit_contradiction",
        candidate,
        existing,
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:00.000Z",
      },
    });

    const response = await PATCH(new Request(
      "http://localhost/api/memory/memory-a",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Thursday",
          contradiction: true,
        }),
      },
    ), { params: Promise.resolve({ id: "memory-a" }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      previous: { claimStatus: "active" },
      corrected: { claimStatus: "candidate" },
      review: { status: "pending" },
    });
    expect(routeMocks.queueMemoryGraphRebuild).not.toHaveBeenCalled();
    expect(routeMocks.indexUserPrivateMemoryGraphRecords).not.toHaveBeenCalled();
    expect(routeMocks.projectExplicitMemoryEntities).not.toHaveBeenCalled();
    expect(routeMocks.retireEntityMemoryLineage).not.toHaveBeenCalled();
  });
});
