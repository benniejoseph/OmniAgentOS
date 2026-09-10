import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureIngestGuard } from "@/lib/capture/ingest-guard";
import { createExecutionScope } from "@/lib/security/execution-scope";

const mocks = vi.hoisted(() => ({
  createKnowledgeDocument: vi.fn(),
  embedTexts: vi.fn(async () => [[0.1, 0.2]]),
  indexMemoryGraphRecords: vi.fn(async () => undefined),
  queueMemoryGraphRebuild: vi.fn(async () => undefined),
  retireSupersededCaptureKnowledge: vi.fn(async () => ({
    documents: 0,
    memories: 0,
  })),
  saveMemories: vi.fn(),
}));

vi.mock("@/lib/openai/client", () => ({ embedTexts: mocks.embedTexts }));
vi.mock("@/lib/rag/store", () => ({
  createKnowledgeDocument: mocks.createKnowledgeDocument,
  retireSupersededCaptureKnowledge: mocks.retireSupersededCaptureKnowledge,
  searchKnowledge: vi.fn(),
}));
vi.mock("@/lib/memory/store", () => ({
  saveMemories: mocks.saveMemories,
  searchMemories: vi.fn(),
}));
vi.mock("@/lib/memory/graph", () => ({
  indexMemoryGraphRecords: mocks.indexMemoryGraphRecords,
  queueMemoryGraphRebuild: mocks.queueMemoryGraphRebuild,
}));

import { ingestTextDocument } from "@/lib/rag/retriever";

const guard: CaptureIngestGuard = {
  kind: "asset",
  captureId: "asset-a",
  tenantId: "tenant-a",
  actorId: "owner-a",
  ingestJobId: "job-a",
};

const sourceLineage = {
  executionScope: createExecutionScope({
    tenantId: guard.tenantId,
    initiatingActorId: guard.actorId,
    executingPrincipalType: "system",
    executingPrincipalId: "capture.ingest",
    correlationId: guard.ingestJobId,
    purpose: "capture.knowledge.ingest",
  }),
  connectionId: "first_party.capture",
  adapterId: "asael.capture",
  adapterVersionId: "1",
  externalItemId: `asset:${guard.captureId}`,
  providerRevisionId: guard.ingestJobId,
  sourceKind: "capture" as const,
  capturedAt: "2026-09-05T00:00:00.000Z",
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
    mocks.queueMemoryGraphRebuild.mockReset().mockResolvedValue(undefined);
    mocks.retireSupersededCaptureKnowledge.mockReset().mockResolvedValue({
      documents: 0,
      memories: 0,
    });
    mocks.embedTexts.mockClear();
  });

  it("defers graph projection through the durable coalescing queue", async () => {
    await ingestTextDocument({
      tenantId: guard.tenantId,
      title: "Connected source",
      content: "Bounded provider page",
      source: "google:mail:message-a",
      sourceLineage,
      deferMemoryGraphIndex: true,
    });

    expect(mocks.indexMemoryGraphRecords).not.toHaveBeenCalled();
    expect(mocks.queueMemoryGraphRebuild).toHaveBeenCalledWith({
      tenantId: guard.tenantId,
    });
  });

  it("carries the same lock guard through knowledge, memory, and graph writes", async () => {
    const progress: Array<{ stage: string; chunkCount?: number; memoryCount?: number }> = [];
    await ingestTextDocument({
      tenantId: guard.tenantId,
      title: "Capture",
      content: "Captured text",
      source: "capture:asset:asset-a",
      captureIngestGuard: guard,
      sourceLineage,
      onProgress: (update) => {
        progress.push(update);
      },
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
    expect(mocks.retireSupersededCaptureKnowledge).toHaveBeenCalledWith({
      captureIngestGuard: guard,
      executionScope: sourceLineage.executionScope,
      keepDocumentId: "document-a",
    });
    expect(
      mocks.retireSupersededCaptureKnowledge.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.indexMemoryGraphRecords.mock.invocationCallOrder[0]);
    expect(progress).toEqual([
      { stage: "chunking" },
      { stage: "embedding", chunkCount: 1 },
      { stage: "knowledge", chunkCount: 1 },
      { stage: "entities", chunkCount: 1 },
      { stage: "memory", chunkCount: 1 },
      { stage: "graph", chunkCount: 1, memoryCount: 1 },
    ]);
  });

  it("rejects actor-attributed ingestion without canonical source lineage", async () => {
    await expect(ingestTextDocument({
      tenantId: guard.tenantId,
      title: "Unlineaged",
      content: "This write must not reach the index.",
      usageScope: {
        tenantId: guard.tenantId,
        actorId: guard.actorId,
        sourceStreamId: "test:unlineaged",
        operation: "embedding",
        purpose: "knowledge.ingest.test",
        credentialSource: "deployment_environment",
      },
    })).rejects.toThrow(/requires canonical source lineage/i);
    expect(mocks.createKnowledgeDocument).not.toHaveBeenCalled();
  });
});
