import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyKnowledgeChunkEmbeddingBackfill: vi.fn(),
  authorizeRequest: vi.fn(),
  embedTextsWithRuntime: vi.fn(),
  getKnowledgeStats: vi.fn(),
  listKnowledgeChunksMissingEmbeddings: vi.fn(),
  requestMemoryAccessFromSecurityContext: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  EMBEDDING_DIMENSIONS: 3,
  EMBEDDING_MODEL: "embedding-test",
}));
vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: <TArgs extends unknown[], TResult>(
    handler: (...args: TArgs) => TResult,
  ) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn(() =>
    Response.json({ error: "forbidden" }, { status: 403 })
  ),
}));
vi.mock("@/lib/memory/request-access", () => ({
  requestMemoryAccessFromSecurityContext:
    mocks.requestMemoryAccessFromSecurityContext,
}));
vi.mock("@/lib/openai/client", () => ({
  embedTextsWithRuntime: mocks.embedTextsWithRuntime,
}));
vi.mock("@/lib/rag/store", () => ({
  applyKnowledgeChunkEmbeddingBackfill:
    mocks.applyKnowledgeChunkEmbeddingBackfill,
  getKnowledgeStats: mocks.getKnowledgeStats,
  listKnowledgeChunksMissingEmbeddings:
    mocks.listKnowledgeChunksMissingEmbeddings,
}));

import { POST } from "@/app/api/memory/indexing/route";

describe("memory knowledge indexing route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue({
      tenantId: "tenant-a",
      actorId: "owner@example.test",
      role: "admin",
      source: "session",
    });
    mocks.requestMemoryAccessFromSecurityContext.mockReturnValue({
      actorBinding: { canonicalActorId: "actor:owner-a" },
      executionScope: { correlationId: "index-test" },
      databaseAccessScope: { purposeId: "memory.write.v1" },
    });
    mocks.listKnowledgeChunksMissingEmbeddings.mockResolvedValue([{
      id: "chunk-a",
      content: "untrusted evidence text",
      updatedAt: "2026-09-09T00:00:00.000Z",
    }]);
    mocks.embedTextsWithRuntime.mockResolvedValue({
      vectors: [[0.1, 0.2, 0.3]],
      provider: "openai",
      model: "settings-embedding-model",
      dimensions: 3,
    });
    mocks.applyKnowledgeChunkEmbeddingBackfill.mockResolvedValue({
      updatedCount: 1,
      chunkSetSha256: "a".repeat(64),
    });
    mocks.getKnowledgeStats.mockResolvedValue({
      documents: 1,
      chunks: 2,
      characters: 42,
      embedded: 2,
    });
  });

  it("meters and persists one bounded embedding batch", async () => {
    const response = await POST(new Request(
      "http://localhost/api/memory/indexing",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "backfill_embeddings", limit: 48 }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.embedTextsWithRuntime).toHaveBeenCalledWith(
      ["untrusted evidence text"],
      undefined,
      expect.objectContaining({
        tenantId: "tenant-a",
        actorId: "actor:owner-a",
        purpose: "knowledge.embedding_backfill",
      }),
    );
    expect(mocks.applyKnowledgeChunkEmbeddingBackfill).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        provider: "openai",
        model: "settings-embedding-model",
        dimensions: 3,
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      processed: 1,
      remaining: 0,
      complete: true,
    });
  });

  it("preserves lexical search when the provider is unavailable", async () => {
    mocks.embedTextsWithRuntime.mockResolvedValue(null);
    const response = await POST(new Request(
      "http://localhost/api/memory/indexing",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "backfill_embeddings", limit: 12 }),
      },
    ));

    expect(response.status).toBe(503);
    expect(mocks.applyKnowledgeChunkEmbeddingBackfill).not.toHaveBeenCalled();
  });
});
