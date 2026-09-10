import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueOperationJob: vi.fn(),
  getCognition: vi.fn(),
  getSource: vi.fn(),
}));

vi.mock("@/lib/operations/job-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations/job-queue")>()),
  enqueueOperationJob: mocks.enqueueOperationJob,
}));

vi.mock("@/lib/knowledge/cognification-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge/cognification-store")>()),
  getKnowledgeCognition: mocks.getCognition,
}));

vi.mock("@/lib/rag/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rag/store")>()),
  getActorOwnedKnowledgeForCognition: mocks.getSource,
}));

import {
  enqueueKnowledgeCognificationPlan,
  knowledgeCognifyJobRequestSchema,
} from "@/lib/operations/background-jobs";
import { createExecutionScope } from "@/lib/security/execution-scope";

const tenantId = "tenant-cognition-reconcile";
const actorId = "owner-cognition-reconcile";
const executionScope = createExecutionScope({
  tenantId,
  initiatingActorId: actorId,
  executingPrincipalType: "user",
  executingPrincipalId: actorId,
  correlationId: "cognition-reconcile-request",
  purpose: "knowledge.cognition.queue",
});

describe("knowledge cognition plan reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueOperationJob.mockImplementation(async (input) => ({
      id: `job-${input.payload.request.batchIndex}`,
      tenantId,
      type: "knowledge.cognify",
      status: "queued",
      payload: input.payload,
      dedupeKey: input.dedupeKey,
      priority: 0,
      attempt: 0,
      maxAttempts: 3,
      runAt: "2026-09-10T00:00:00.000Z",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    }));
  });

  it("resumes the first batch without a persisted candidate", async () => {
    mocks.getSource.mockResolvedValue(source("2026-10-10T00:00:00.000Z"));
    mocks.getCognition.mockResolvedValueOnce({ candidate: { batchIndex: 0 } })
      .mockResolvedValueOnce(null);

    const job = await enqueueKnowledgeCognificationPlan({
      tenantId,
      actorId,
      executionScope,
      documentId: "knowledge-document",
      sourceRevisionId: "source-revision",
    });

    expect(mocks.getCognition).toHaveBeenCalledTimes(2);
    expect(job).toMatchObject({
      id: "job-1",
      payload: {
        request: {
          batchIndex: 1,
          retentionExpiresAt: "2026-10-10T00:00:00.000Z",
          sourcePlanSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(mocks.enqueueOperationJob).toHaveBeenCalledWith(expect.objectContaining({
      requeueTerminal: false,
      requeueFailed: true,
    }));
  });

  it("changes job identity when the current retention plan changes", async () => {
    mocks.getCognition.mockResolvedValue(null);
    mocks.getSource.mockResolvedValueOnce(source("2026-10-10T00:00:00.000Z"));
    await enqueueKnowledgeCognificationPlan({
      tenantId,
      actorId,
      executionScope,
      documentId: "knowledge-document",
      sourceRevisionId: "source-revision",
    });
    const first = mocks.enqueueOperationJob.mock.calls[0][0];

    mocks.getSource.mockResolvedValueOnce(source("2026-09-20T00:00:00.000Z"));
    await enqueueKnowledgeCognificationPlan({
      tenantId,
      actorId,
      executionScope,
      documentId: "knowledge-document",
      sourceRevisionId: "source-revision",
    });
    const second = mocks.enqueueOperationJob.mock.calls[1][0];

    expect(second.dedupeKey).not.toBe(first.dedupeKey);
    expect(second.payload.request.sourcePlanSha256)
      .not.toBe(first.payload.request.sourcePlanSha256);
    expect(second.payload.request.retentionExpiresAt)
      .toBe("2026-09-20T00:00:00.000Z");
  });

  it("accepts legacy unbound jobs but rejects partial plan bindings", () => {
    expect(knowledgeCognifyJobRequestSchema.safeParse({
      documentId: "knowledge-document",
      sourceRevisionId: "source-revision",
      batchIndex: 0,
    }).success).toBe(true);
    expect(knowledgeCognifyJobRequestSchema.safeParse({
      documentId: "knowledge-document",
      sourceRevisionId: "source-revision",
      batchIndex: 0,
      sourcePlanSha256: "a".repeat(64),
    }).success).toBe(false);
  });
});

function source(retentionExpiresAt: string) {
  return {
    document: {
      id: "knowledge-document",
      tenantId,
      sourceItemId: "source-item",
      sourceRevisionId: "source-revision",
      title: "ICT transcript",
      source: "capture:asset:ict",
      sourceType: "file" as const,
      tags: [],
      contentHash: "content-hash",
      chunkCount: 13,
      totalCharacters: 234,
      metadata: {},
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    },
    chunks: Array.from({ length: 13 }, (_, index) => ({
      id: `chunk-${index}`,
      tenantId,
      documentId: "knowledge-document",
      sourceRevisionId: "source-revision",
      evidenceUnitId: `evidence-${index}`,
      chunkIndex: index,
      title: "ICT transcript",
      content: `Evidence chunk ${index}.`,
      tags: [],
      source: "capture:asset:ict",
      tokenEstimate: 4,
      characterCount: 17,
      metadata: {},
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    })),
    sourceItemId: "source-item",
    sourceRevisionId: "source-revision",
    retentionExpiresAt,
  };
}
