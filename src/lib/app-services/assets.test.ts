import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueCaptureAssetProcessJob: vi.fn(),
  getCaptureAsset: vi.fn(),
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

vi.mock("@/lib/operations/background-jobs", () => ({
  enqueueCaptureAssetProcessJob: mocks.enqueueCaptureAssetProcessJob,
  enqueueKnowledgeIngestJob: vi.fn(),
}));

import { indexStoredAssetService } from "@/lib/app-services/assets";
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCaptureAsset.mockResolvedValue(asset);
  mocks.enqueueCaptureAssetProcessJob.mockResolvedValue({
    id: "job-a",
    tenantId: context.tenantId,
    type: "capture.asset.process",
    status: "queued",
    payload: { actorId: context.actorId, progress: { stage: "queued" } },
    priority: 1,
    attempt: 0,
    maxAttempts: 3,
    runAt: "2026-09-10T00:00:00.000Z",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  });
  mocks.updateCaptureAssetStatus.mockResolvedValue({
    ...asset,
    status: "queued",
    extractionStatus: "pending",
    ingestJobId: "job-a",
    extractionReceipt: undefined,
  });
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
});
