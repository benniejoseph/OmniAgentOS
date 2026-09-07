import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  embedRetrievalTexts: vi.fn(),
  getKnowledgeStats: vi.fn(),
  ingestTextDocument: vi.fn(),
  searchKnowledge: vi.fn(),
}));

vi.mock("@/lib/rag/retrieval-embedding", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/rag/retrieval-embedding")
  >()),
  embedRetrievalTexts: mocks.embedRetrievalTexts,
}));
vi.mock("@/lib/rag/retriever", () => ({
  ingestTextDocument: mocks.ingestTextDocument,
}));
vi.mock("@/lib/rag/store", () => ({
  deleteKnowledgeDocumentsBySourcePrefix: vi.fn(),
  getKnowledgeStats: mocks.getKnowledgeStats,
  listKnowledgeChunks: vi.fn(),
  listKnowledgeDocuments: vi.fn(),
  searchKnowledge: mocks.searchKnowledge,
}));

import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  ingestKnowledgeService,
  searchKnowledgeService,
} from "@/lib/app-services/knowledge";
import { createExecutionScope } from "@/lib/security/execution-scope";

const context = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  role: "operator" as const,
  source: "service" as const,
};
const executionScope = createExecutionScope({
  tenantId: context.tenantId,
  initiatingActorId: context.actorId,
  executingPrincipalType: "agent",
  executingPrincipalId: "main-agent",
  correlationId: "knowledge-operation-a",
  purpose: "tool.knowledge",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.embedRetrievalTexts.mockResolvedValue({
    vectors: [[0.1, 0.2]],
    receipt: {
      provider: "local",
      spaceId: "local-test-space",
      externalDisclosure: false,
    },
  });
  mocks.searchKnowledge.mockResolvedValue([]);
  mocks.getKnowledgeStats.mockResolvedValue({
    documents: 0,
    chunks: 0,
    characters: 0,
    embedded: 0,
  });
  mocks.ingestTextDocument.mockResolvedValue({
    document: { id: "document-a" },
    chunks: [{ id: "chunk-a" }],
    memories: [],
  });
});

describe("P9.1 knowledge application service", () => {
  it("binds search to the authenticated tenant and emits a service receipt", async () => {
    const result = await searchKnowledgeService(
      createAppServiceCaller({ context, executionScope }),
      { query: "restore database", limit: 5 },
    );
    expect(mocks.searchKnowledge).toHaveBeenCalledWith(
      "restore database",
      expect.objectContaining({
        tenantId: context.tenantId,
        queryEmbeddingSpaceId: "local-test-space",
      }),
    );
    expect(result.receipt).toMatchObject({
      operation: "knowledge.search",
      accessMode: "read",
    });
  });

  it("requires and propagates exact mutation attribution for ingest", async () => {
    const caller = createAppServiceCaller({
      context,
      executionScope,
      idempotencyKey: "knowledge-ingest-a",
    });
    const result = await ingestKnowledgeService(
      caller,
      { title: "Runbook", content: "Restore the latest backup." },
      { observedAt: "2026-09-07T00:00:00.000Z" },
    );
    expect(mocks.ingestTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: context.tenantId,
        executionScope,
        sourceLineage: expect.objectContaining({
          executionScope,
          externalItemId: "knowledge-ingest-a",
        }),
      }),
    );
    expect(result).toMatchObject({
      data: { chunks: 1, memories: 0 },
      receipt: {
        operation: "knowledge.ingest",
        accessMode: "mutation",
        eventContract: "memory.atomic-events.v1",
      },
    });
  });
});
