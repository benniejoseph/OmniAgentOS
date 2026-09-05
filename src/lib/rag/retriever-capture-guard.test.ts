import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureIngestGuard } from "@/lib/capture/ingest-guard";

const mocks = vi.hoisted(() => ({
  createKnowledgeDocument: vi.fn(),
  embedTexts: vi.fn(async () => [[0.1, 0.2]]),
  indexMemoryGraphRecords: vi.fn(async () => undefined),
  saveMemories: vi.fn(),
}));

vi.mock("@/lib/openai/client", () => ({ embedTexts: mocks.embedTexts }));
vi.mock("@/lib/rag/store", () => ({
  createKnowledgeDocument: mocks.createKnowledgeDocument,
  searchKnowledge: vi.fn(),
}));
vi.mock("@/lib/memory/store", () => ({
  saveMemories: mocks.saveMemories,
  searchMemories: vi.fn(),
}));
vi.mock("@/lib/memory/graph", () => ({
  indexMemoryGraphRecords: mocks.indexMemoryGraphRecords,
}));

import { ingestTextDocument } from "@/lib/rag/retriever";

const guard: CaptureIngestGuard = {
  kind: "asset",
  captureId: "asset-a",
  tenantId: "tenant-a",
  actorId: "owner-a",
  ingestJobId: "job-a",
};

describe("capture ingestion persistence guard", () => {
  beforeEach(() => {
    mocks.createKnowledgeDocument.mockReset().mockResolvedValue({
      document: { id: "document-a" },
      chunks: [{ id: "chunk-a" }],
      lineage: undefined,
    });
    mocks.saveMemories.mockReset().mockResolvedValue([{
      id: "memory-a",
      tenantId: guard.tenantId,
      source: "capture:asset:asset-a",
    }]);
    mocks.indexMemoryGraphRecords.mockReset().mockResolvedValue(undefined);
    mocks.embedTexts.mockClear();
  });

  it("carries the same lock guard through knowledge, memory, and graph writes", async () => {
    await ingestTextDocument({
      tenantId: guard.tenantId,
      title: "Capture",
      content: "Captured text",
      source: "capture:asset:asset-a",
      captureIngestGuard: guard,
    });

    expect(mocks.createKnowledgeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ captureIngestGuard: guard }),
    );
    expect(mocks.saveMemories).toHaveBeenCalledWith(
      expect.any(Array),
      { captureIngestGuard: guard },
    );
    expect(mocks.indexMemoryGraphRecords).toHaveBeenCalledWith(
      expect.any(Array),
      "knowledge.ingest",
      { captureIngestGuard: guard },
    );
  });
});
