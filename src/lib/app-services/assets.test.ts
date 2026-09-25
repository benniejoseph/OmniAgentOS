import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelOperationJobByDedupeKey: vi.fn(),
  deleteCaptureAssetWithKnowledge: vi.fn(),
  enqueueCaptureAssetProcessJob: vi.fn(),
  getCaptureAsset: vi.fn(),
  getOperationJob: vi.fn(),
  updateCaptureAssetStatus: vi.fn(),
}));

vi.mock("@/lib/capture/assets", () => ({
  CaptureAssetError: class CaptureAssetError extends Error {
    constructor(message: string, public readonly status = 400) {
      super(message);
    }
  },
  getCaptureAsset: mocks.getCaptureAsset,
  getCaptureAssetForRequest: vi.fn(),
  listCaptureAssets: vi.fn(),
  updateCaptureAssetStatus: mocks.updateCaptureAssetStatus,
}));

vi.mock("@/lib/capture/deletion", () => ({
  deleteCaptureAssetWithKnowledge: mocks.deleteCaptureAssetWithKnowledge,
  deleteCaptureRecordingWithKnowledge: vi.fn(),
}));

vi.mock("@/lib/operations/background-jobs", () => ({
  enqueueCaptureAssetProcessJob: mocks.enqueueCaptureAssetProcessJob,
  enqueueKnowledgeIngestJob: vi.fn(),
}));

vi.mock("@/lib/operations/job-queue", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/operations/job-queue")>(),
  cancelOperationJobByDedupeKey: mocks.cancelOperationJobByDedupeKey,
  getOperationJob: mocks.getOperationJob,
}));

import {
  deleteAssetService,
  indexStoredAssetService,
  previewAssetDeleteService,
} from "@/lib/app-services/assets";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";

const context = {
  tenantId: "tenant-a",
  actorId: "owner-a",
  role: "operator" as const,
  source: "service" as const,
};
const executionScope = createExecutionScope({
  tenantId: context.tenantId,
  initiatingActorId: context.actorId,
  executingPrincipalType: "agent",
  executingPrincipalId: "main-agent",
  correlationId: "capture-reindex-a",
  purpose: "capture.asset.index",
});
const asset = {
  id: "asset-a",
  tenantId: context.tenantId,
  actorId: context.actorId,
  filename: "ict-transcript.vtt",
  mediaType: "text/vtt",
  extension: "vtt",
  byteCount: 4096,
  contentSha256: "a".repeat(64),
  storageKind: "database" as const,
  status: "indexed" as const,
  extractionStatus: "completed" as const,
  extractionReceipt: { state: "completed" },
  tags: ["ict"],
  metadata: {},
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
};

function operationJob(input: {
  id?: string;
  status?: "queued" | "running" | "completed" | "failed" | "canceled";
  actorId?: string;
  result?: Record<string, unknown>;
}) {
  return {
    id: input.id || "job-a",
    tenantId: context.tenantId,
    type: "capture.asset.process" as const,
    status: input.status || "queued",
    payload: {
      actorId: input.actorId || context.actorId,
      progress: { stage: input.status || "queued" },
      ...(input.result ? { result: input.result } : {}),
    },
    priority: 1,
    attempt: 0,
    maxAttempts: 3,
    runAt: "2026-09-10T00:00:00.000Z",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCaptureAsset.mockResolvedValue(asset);
  mocks.getOperationJob.mockResolvedValue(null);
  mocks.enqueueCaptureAssetProcessJob.mockResolvedValue(operationJob({}));
  mocks.updateCaptureAssetStatus.mockResolvedValue({
    ...asset,
    status: "queued",
    extractionStatus: "pending",
    ingestJobId: "job-a",
    extractionReceipt: undefined,
  });
  mocks.deleteCaptureAssetWithKnowledge.mockResolvedValue({ documents: 1 });
});

describe("Capture asset application service", () => {
  it("reindexes through the same content-free asset processing job", async () => {
    const caller = createAppServiceCaller({
      context,
      executionScope,
      idempotencyKey: "reindex-request-a",
    });

    const result = await indexStoredAssetService(caller, {
      id: asset.id,
      title: "ICT market structure",
      note: "Prefer the transcript timecodes.",
      tags: ["market-structure"],
    });

    expect(mocks.enqueueCaptureAssetProcessJob).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      executionScope,
      idempotencyKey: "reindex-request-a",
      request: {
        assetId: asset.id,
        title: "ICT market structure",
        note: "Prefer the transcript timecodes.",
        tags: ["market-structure"],
      },
    });
    expect(mocks.updateCaptureAssetStatus).toHaveBeenCalledWith(
      asset.id,
      { tenantId: context.tenantId, actorId: context.actorId, executionScope },
      {
        status: "queued",
        extractionStatus: "pending",
        ingestJobId: "job-a",
        clearExtractionReceipt: true,
      },
    );
    expect(result.data).toMatchObject({
      asset: { status: "queued", ingestJobId: "job-a" },
      job: { id: "job-a", type: "capture.asset.process", status: "queued" },
    });
    expect(JSON.stringify(result.data.job)).not.toContain("Prefer the transcript");
  });

  it.each(["queued", "running"] as const)(
    "returns the active linked %s job instead of enqueuing duplicate work",
    async (status) => {
      const queuedAsset = {
        ...asset,
        status: "queued" as const,
        ingestJobId: "job-a",
      };
      mocks.getCaptureAsset.mockResolvedValue(queuedAsset);
      mocks.getOperationJob.mockResolvedValue(operationJob({ status }));
      const caller = createAppServiceCaller({
        context,
        executionScope,
        idempotencyKey: "repeat-request-a",
      });

      const result = await indexStoredAssetService(caller, { id: asset.id });

      expect(mocks.getOperationJob).toHaveBeenCalledWith("job-a", {
        tenantId: context.tenantId,
      });
      expect(mocks.enqueueCaptureAssetProcessJob).not.toHaveBeenCalled();
      expect(mocks.updateCaptureAssetStatus).not.toHaveBeenCalled();
      expect(result.data).toMatchObject({
        asset: { id: asset.id, ingestJobId: "job-a" },
        job: { id: "job-a", status },
        duplicate: true,
      });
    },
  );

  it("repairs a queued asset whose linked job already completed", async () => {
    const queuedAsset = {
      ...asset,
      status: "queued" as const,
      ingestJobId: "job-a",
    };
    const repairedAsset = {
      ...queuedAsset,
      status: "indexed" as const,
      knowledgeDocumentId: "knowledge-a",
    };
    mocks.getCaptureAsset.mockResolvedValue(queuedAsset);
    mocks.getOperationJob.mockResolvedValue(operationJob({
      status: "completed",
      result: { documentId: "knowledge-a", chunkCount: 12 },
    }));
    mocks.updateCaptureAssetStatus.mockResolvedValue(repairedAsset);
    const caller = createAppServiceCaller({
      context,
      executionScope,
      idempotencyKey: "repair-request-a",
    });

    const result = await indexStoredAssetService(caller, { id: asset.id });

    expect(mocks.updateCaptureAssetStatus).toHaveBeenCalledWith(
      asset.id,
      { tenantId: context.tenantId, actorId: context.actorId, executionScope },
      {
        status: "indexed",
        extractionStatus: "completed",
        ingestJobId: "job-a",
        expectedIngestJobId: "job-a",
        knowledgeDocumentId: "knowledge-a",
      },
    );
    expect(mocks.enqueueCaptureAssetProcessJob).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      asset: { status: "indexed", knowledgeDocumentId: "knowledge-a" },
      job: { id: "job-a", status: "completed" },
      duplicate: true,
      repaired: true,
    });
  });

  it("does not trust a linked active job from a different actor", async () => {
    const queuedAsset = {
      ...asset,
      status: "queued" as const,
      ingestJobId: "job-a",
    };
    mocks.getCaptureAsset.mockResolvedValue(queuedAsset);
    mocks.getOperationJob.mockResolvedValue(operationJob({
      status: "running",
      actorId: "owner-b",
    }));
    mocks.enqueueCaptureAssetProcessJob.mockResolvedValue(operationJob({ id: "job-b" }));
    mocks.updateCaptureAssetStatus.mockResolvedValue({
      ...queuedAsset,
      ingestJobId: "job-b",
      extractionStatus: "pending",
    });
    const caller = createAppServiceCaller({
      context,
      executionScope,
      idempotencyKey: "actor-fence-request-a",
    });

    const result = await indexStoredAssetService(caller, { id: asset.id });

    expect(mocks.enqueueCaptureAssetProcessJob).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: context.tenantId,
        actorId: context.actorId,
        executionScope,
      }),
    );
    expect(result.data).toMatchObject({
      asset: { ingestJobId: "job-b" },
      job: { id: "job-b" },
    });
  });

  it.each(["failed", "canceled", "missing"] as const)(
    "enqueues fresh work when the linked job is %s",
    async (status) => {
      const queuedAsset = {
        ...asset,
        status: "queued" as const,
        ingestJobId: "job-a",
      };
      mocks.getCaptureAsset.mockResolvedValue(queuedAsset);
      mocks.getOperationJob.mockResolvedValue(
        status === "missing" ? null : operationJob({ status }),
      );
      mocks.enqueueCaptureAssetProcessJob.mockResolvedValue(operationJob({ id: "job-b" }));
      mocks.updateCaptureAssetStatus.mockResolvedValue({
        ...queuedAsset,
        ingestJobId: "job-b",
        extractionStatus: "pending",
      });
      const caller = createAppServiceCaller({
        context,
        executionScope,
        idempotencyKey: "retry-request-a",
      });

      const result = await indexStoredAssetService(caller, { id: asset.id });

      expect(mocks.enqueueCaptureAssetProcessJob).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: context.tenantId,
          actorId: context.actorId,
          executionScope,
          idempotencyKey: expect.stringMatching(/^capture-asset-retry:[a-f0-9]{64}$/),
          request: { assetId: asset.id },
        }),
      );
      expect(mocks.updateCaptureAssetStatus).toHaveBeenCalledWith(
        asset.id,
        { tenantId: context.tenantId, actorId: context.actorId, executionScope },
        {
          status: "queued",
          extractionStatus: "pending",
          ingestJobId: "job-b",
          expectedIngestJobId: "job-a",
          clearExtractionReceipt: true,
        },
      );
      expect(result.data).toMatchObject({
        asset: { ingestJobId: "job-b" },
        job: { id: "job-b", status: "queued" },
      });
    },
  );

  it("deletes exactly the asset its preview described", async () => {
    const caller = createAppServiceCaller({
      context,
      executionScope,
      idempotencyKey: "delete-request-a",
    });
    const preview = await previewAssetDeleteService(caller, {
      kind: "asset",
      id: asset.id,
    });

    const result = await deleteAssetService(caller, {
      kind: "asset",
      id: asset.id,
      expectedTargetSha256: preview.data.targetSha256,
    });

    expect(mocks.deleteCaptureAssetWithKnowledge).toHaveBeenCalledWith(asset, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      executionScope,
    });
    expect(result.data).toMatchObject({
      deleted: true,
      forgotten: { documents: 1 },
      target: { kind: "asset", id: asset.id, contentSha256: asset.contentSha256 },
      targetSha256: preview.data.targetSha256,
    });
  });

  it("refuses to delete an asset that changed after its preview", async () => {
    const caller = createAppServiceCaller({
      context,
      executionScope,
      idempotencyKey: "delete-request-b",
    });
    const preview = await previewAssetDeleteService(caller, {
      kind: "asset",
      id: asset.id,
    });
    mocks.getCaptureAsset.mockResolvedValue({
      ...asset,
      contentSha256: "b".repeat(64),
    });

    await expect(deleteAssetService(caller, {
      kind: "asset",
      id: asset.id,
      expectedTargetSha256: preview.data.targetSha256,
    })).rejects.toThrow("changed after preview");
    expect(mocks.cancelOperationJobByDedupeKey).not.toHaveBeenCalled();
    expect(mocks.deleteCaptureAssetWithKnowledge).not.toHaveBeenCalled();
  });
});
