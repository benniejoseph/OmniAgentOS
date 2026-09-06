import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  deleteKnowledgeDocumentsBySourcePrefix: vi.fn(),
  getKnowledgeStats: vi.fn(),
  searchKnowledge: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (request: Request) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/openai/client", () => ({
  embedTexts: vi.fn(),
}));

vi.mock("@/lib/rag/store", () => ({
  deleteKnowledgeDocumentsBySourcePrefix:
    routeMocks.deleteKnowledgeDocumentsBySourcePrefix,
  getKnowledgeStats: routeMocks.getKnowledgeStats,
  listKnowledgeChunks: vi.fn(),
  listKnowledgeDocuments: vi.fn(),
  searchKnowledge: routeMocks.searchKnowledge,
}));

import { DELETE, GET } from "@/app/api/knowledge/route";
import { knowledgeDeletionTargetId } from "@/lib/rag/deletion-events";
import { LOCAL_MULTILINGUAL_EMBEDDING_SPACE } from "@/lib/rag/retrieval-embedding";

describe("knowledge deletion route", () => {
  beforeEach(() => {
    routeMocks.authorizeRequest.mockReset().mockResolvedValue({
      tenantId: "tenant-a",
      actorId: "owner@example.test",
      role: "admin",
      source: "session",
    });
    routeMocks.deleteKnowledgeDocumentsBySourcePrefix
      .mockReset()
      .mockResolvedValue({ documents: 1, memories: 1 });
    routeMocks.getKnowledgeStats.mockReset().mockResolvedValue({
      documents: 1,
      chunks: 1,
      characters: 32,
      embedded: 0,
    });
    routeMocks.searchKnowledge.mockReset().mockResolvedValue([]);
  });

  it("binds supported source deletion to the authenticated request", async () => {
    const source = "google:drive:";
    const response = await DELETE(new Request(
      `http://localhost/api/knowledge?source=${encodeURIComponent(source)}`,
      {
        method: "DELETE",
        headers: {
          "idempotency-key": "knowledge-delete-1",
          "x-request-id": "knowledge-delete-request-1",
        },
      },
    ));

    expect(response.status).toBe(200);
    expect(routeMocks.deleteKnowledgeDocumentsBySourcePrefix).toHaveBeenCalledWith(
      source,
      {
        tenantId: "tenant-a",
        actorId: "owner@example.test",
        mutation: {
          idempotencyKey: "knowledge-delete-1",
          executionScope: expect.objectContaining({
            tenantId: "tenant-a",
            initiatingActorId: "owner@example.test",
            executingPrincipalType: "user",
            executingPrincipalId: "owner@example.test",
            correlationId: "knowledge-delete-request-1",
            causationId: knowledgeDeletionTargetId(source),
            purpose: "knowledge.delete_source",
          }),
        },
      },
    );
  });

  it("uses the local embedding space for authenticated search", async () => {
    routeMocks.searchKnowledge.mockResolvedValue([{
      chunk: {
        id: "chunk-a",
        tenantId: "tenant-a",
        documentId: "document-a",
        chunkIndex: 0,
        title: "Database restore",
        content: "Restore the latest backup.",
        tags: [],
        source: "manual",
        tokenEstimate: 8,
        characterCount: 26,
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:00.000Z",
      },
      score: 0.8,
      vectorScore: 0.7,
      lexicalScore: 0,
      recencyScore: 0.6,
      reasons: ["semantic match"],
    }]);

    const response = await GET(new Request(
      "http://localhost/api/knowledge?q=restaurar%20base%20de%20datos",
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(routeMocks.searchKnowledge).toHaveBeenCalledWith(
      "restaurar base de datos",
      expect.objectContaining({
        queryEmbeddingSpaceId: LOCAL_MULTILINGUAL_EMBEDDING_SPACE,
      }),
    );
    expect(body).toMatchObject({
      results: [{ chunk: { id: "chunk-a" } }],
      retrieval: {
        embedding: { provider: "local", externalDisclosure: false },
        reranker: { algorithm: "pairwise_logistic_regression" },
      },
    });
  });
});
