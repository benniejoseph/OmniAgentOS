import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  deleteKnowledgeDocumentsBySourcePrefix: vi.fn(),
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
  getKnowledgeStats: vi.fn(),
  listKnowledgeChunks: vi.fn(),
  listKnowledgeDocuments: vi.fn(),
  searchKnowledge: vi.fn(),
}));

import { DELETE } from "@/app/api/knowledge/route";
import { knowledgeDeletionTargetId } from "@/lib/rag/deletion-events";

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
});
