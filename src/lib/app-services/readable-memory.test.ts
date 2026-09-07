import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listMemories: vi.fn(),
  listReviews: vi.fn(),
  listDeletionReceipts: vi.fn(),
  listTraces: vi.fn(),
  readEntityRegistry: vi.fn(),
}));

vi.mock("@/lib/memory/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/store")>()),
  listMemories: mocks.listMemories,
  listMemoryReconciliationReviews: mocks.listReviews,
  listAttributedMemoryDeletionReceipts: mocks.listDeletionReceipts,
}));
vi.mock("@/lib/rag/context-engine", () => ({
  listRetrievalTraces: mocks.listTraces,
}));
vi.mock("@/lib/entities/store", () => ({
  readEntityRegistry: mocks.readEntityRegistry,
}));

import { showReadableMemoryService } from "@/lib/app-services/readable-memory";

const caller = {
  context: {
    tenantId: "tenant:test",
    actorId: "owner@example.test",
    role: "admin" as const,
    source: "session" as const,
    auth: {
      userId: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test",
      sessionId: "session:test",
      tenantName: "Test",
    },
  },
};

beforeEach(() => {
  mocks.listMemories.mockReset().mockResolvedValue([]);
  mocks.listReviews.mockReset().mockResolvedValue([]);
  mocks.listDeletionReceipts.mockReset().mockResolvedValue([]);
  mocks.listTraces.mockReset().mockResolvedValue([]);
  mocks.readEntityRegistry.mockReset().mockResolvedValue({
    schemaVersion: 1,
    entities: [],
    aliases: [],
    resolutions: [],
    mergeReviews: [],
  });
});

describe("readable Memory application service", () => {
  it("uses canonical/current actor identities for deletion state", async () => {
    const result = await showReadableMemoryService(caller, { limit: 25 });

    expect(mocks.listDeletionReceipts).toHaveBeenCalledWith({
      tenantId: "tenant:test",
      initiatingActorIds: [
        "actor:00000000-0000-4000-8000-000000000001",
        "owner@example.test",
      ],
      limit: 25,
    });
    expect(result.receipt.operation).toBe("app.memory.readable.show");
    expect(result.data.overview).toMatchObject({
      version: "p11.6-readable-memory:1",
      state: "empty",
      disclosure: { aggregate: "metadata_only" },
    });
  });
});
