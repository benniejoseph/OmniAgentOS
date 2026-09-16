import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  indexMemoryGraphRecords: vi.fn(),
  indexUserPrivateMemoryGraphRecords: vi.fn(),
  getOwnedThread: vi.fn(),
  listMemories: vi.fn(),
  listThreadMemories: vi.fn(),
  projectExplicitMemoryEntities: vi.fn(),
  saveMemory: vi.fn(),
  searchMemories: vi.fn(),
  embedTexts: vi.fn(),
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

vi.mock("@/lib/memory/store", () => ({
  listMemories: routeMocks.listMemories,
  listThreadMemories: routeMocks.listThreadMemories,
  saveMemory: routeMocks.saveMemory,
  searchMemories: routeMocks.searchMemories,
}));

vi.mock("@/lib/entities/extraction", () => ({
  projectExplicitMemoryEntities: routeMocks.projectExplicitMemoryEntities,
}));

vi.mock("@/lib/memory/graph", () => ({
  indexMemoryGraphRecords: routeMocks.indexMemoryGraphRecords,
  indexUserPrivateMemoryGraphRecords:
    routeMocks.indexUserPrivateMemoryGraphRecords,
}));

vi.mock("@/lib/openai/client", () => ({
  embedTexts: routeMocks.embedTexts,
}));

vi.mock("@/lib/threads/store", () => ({
  getOwnedThread: routeMocks.getOwnedThread,
}));

import { GET, POST } from "@/app/api/memory/route";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { LOCAL_MULTILINGUAL_EMBEDDING_SPACE } from "@/lib/rag/retrieval-embedding";

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

const legacyMemory = {
  id: "legacy-a",
  title: "Legacy",
  content: "Legacy memory",
  tags: [],
  updatedAt: "2026-09-05T00:00:00.000Z",
};

describe("memory API private canary", () => {
  beforeEach(() => {
    routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
    routeMocks.indexMemoryGraphRecords.mockReset();
    routeMocks.indexUserPrivateMemoryGraphRecords.mockReset();
    routeMocks.getOwnedThread.mockReset().mockResolvedValue(null);
    routeMocks.listMemories.mockReset()
      .mockResolvedValueOnce([legacyMemory])
      .mockResolvedValueOnce([]);
    routeMocks.listThreadMemories.mockReset().mockResolvedValue([]);
    routeMocks.projectExplicitMemoryEntities.mockReset().mockResolvedValue({
      extraction: { candidates: [] },
      createdEntityIds: [],
      linkedEntityIds: [],
      reviewResolutionIds: [],
    });
    routeMocks.saveMemory.mockReset();
    routeMocks.searchMemories.mockReset().mockResolvedValue([]);
    routeMocks.embedTexts.mockReset().mockResolvedValue([]);
  });

  it("combines legacy memory with a separately scoped owner read", async () => {
    const response = await GET(new Request("http://localhost/api/memory"));

    expect(response.status).toBe(200);
    expect(routeMocks.listMemories).toHaveBeenCalledTimes(2);
    expect(routeMocks.listMemories).toHaveBeenLastCalledWith(
      expect.objectContaining({
        accessScope: expect.objectContaining({
          initiatingActorId:
            "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
          purposeId: MEMORY_PURPOSE_IDS.read,
        }),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      memories: [{
        id: "legacy-a",
        tier: "semantic",
        explainability: {
          why: expect.any(String),
          lastUsedAt: null,
          validity: "active",
          policy: { tier: "semantic", version: 1 },
        },
      }],
    });
  });

  it("resolves an owned thread before listing its scoped memory", async () => {
    routeMocks.getOwnedThread.mockResolvedValue({
      id: "thread-a",
      tenantId: context.tenantId,
      actorId: context.actorId,
    });

    const response = await GET(new Request(
      "http://localhost/api/memory?threadId=thread-a&limit=9",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.getOwnedThread).toHaveBeenCalledWith(
      "thread-a",
      expect.objectContaining({
        tenantId: context.tenantId,
        actorId: context.actorId,
        requestActorBinding: expect.objectContaining({
          canonicalActorId:
            "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
        }),
      }),
    );
    expect(routeMocks.listThreadMemories).toHaveBeenCalledTimes(2);
    expect(routeMocks.listThreadMemories).toHaveBeenNthCalledWith(
      1,
      "thread-a",
      { tenantId: context.tenantId, limit: 9 },
    );
    expect(routeMocks.listThreadMemories).toHaveBeenNthCalledWith(
      2,
      "thread-a",
      expect.objectContaining({
        tenantId: context.tenantId,
        limit: 9,
        accessScope: expect.objectContaining({
          initiatingActorId:
            "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
        }),
      }),
    );
  });

  it("creates canonical user-private memory with actor-scoped graph indexing", async () => {
    routeMocks.saveMemory.mockImplementation(async (input) => ({
      ...input,
      id: "private-a",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    }));
    const response = await POST(new Request("http://localhost/api/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Private preference",
        content: "Only I can read this.",
      }),
    }));

    expect(response.status).toBe(201);
    expect(routeMocks.saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      scope: "user",
      accessBinding: expect.objectContaining({
        ownerActorId:
          "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
        visibility: "user_private",
      }),
      databaseAccessScope: expect.objectContaining({
        purposeId: MEMORY_PURPOSE_IDS.write,
      }),
    }));
    expect(routeMocks.indexMemoryGraphRecords).not.toHaveBeenCalled();
    expect(routeMocks.indexUserPrivateMemoryGraphRecords).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "private-a" })],
      "memory.manual",
      expect.objectContaining({
        tenantId: "tenant-a",
        accessScope: expect.objectContaining({
          purposeId: MEMORY_PURPOSE_IDS.write,
        }),
      }),
    );
    expect(routeMocks.projectExplicitMemoryEntities).toHaveBeenCalledWith({
      memory: expect.objectContaining({ id: "private-a" }),
      executionScope: expect.objectContaining({
        initiatingActorId:
          "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
      }),
    });
    await expect(response.json()).resolves.toMatchObject({
      entityProjection: {
        candidateCount: 0,
        createdCount: 0,
        linkedCount: 0,
        reviewRequiredCount: 0,
      },
    });
  });

  it("uses local multilingual search and returns its governed receipts", async () => {
    routeMocks.searchMemories
      .mockReset()
      .mockResolvedValueOnce([{
        record: {
          ...legacyMemory,
          type: "procedure",
          scope: "user",
          source: "manual",
          importance: 0.8,
          claimStatus: "active",
          createdAt: legacyMemory.updatedAt,
        },
        score: 0.7,
        reasons: ["semantic match"],
      }])
      .mockResolvedValueOnce([]);

    const response = await GET(new Request(
      "http://localhost/api/memory?q=restaurar%20base%20de%20datos",
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(routeMocks.embedTexts).not.toHaveBeenCalled();
    expect(routeMocks.searchMemories).toHaveBeenCalledWith(
      "restaurar base de datos",
      expect.objectContaining({
        queryEmbeddingSpaceId: LOCAL_MULTILINGUAL_EMBEDDING_SPACE,
      }),
    );
    expect(body).toMatchObject({
      results: [{ record: { id: "legacy-a" } }],
      retrieval: {
        embedding: { provider: "local", externalDisclosure: false },
        reranker: {
          algorithm: "pairwise_logistic_regression",
          externalDisclosure: false,
        },
      },
    });
  });
});
