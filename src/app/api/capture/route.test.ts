import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  canonicalRequestActorBindingFromSecurityContext: vi.fn(),
  captureExecutionScopeFromSecurityContext: vi.fn(),
  listCaptureAssets: vi.fn(),
  saveCaptureAsset: vi.fn(),
  updateCaptureAssetStatus: vi.fn(),
  enqueueCaptureAssetProcessJob: vi.fn(),
  enqueueKnowledgeIngestJob: vi.fn(),
  getOperationJobsByIds: vi.fn(),
  projectOperationJobStatus: vi.fn(),
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

vi.mock("@/lib/security/canonical-actor", () => ({
  canonicalRequestActorBindingFromSecurityContext:
    routeMocks.canonicalRequestActorBindingFromSecurityContext,
}));

vi.mock("@/lib/capture/execution-scope", () => ({
  captureExecutionScopeFromSecurityContext:
    routeMocks.captureExecutionScopeFromSecurityContext,
}));

vi.mock("@/lib/capture/assets", () => ({
  listCaptureAssets: routeMocks.listCaptureAssets,
  saveCaptureAsset: routeMocks.saveCaptureAsset,
  updateCaptureAssetStatus: routeMocks.updateCaptureAssetStatus,
}));

vi.mock("@/lib/capture/files", () => ({
  captureTitle: (filename: string) => filename.replace(/\.[^.]+$/, ""),
}));

vi.mock("@/lib/operations/background-jobs", () => ({
  BackgroundJobIdempotencyConflictError:
    class BackgroundJobIdempotencyConflictError extends Error {},
  enqueueCaptureAssetProcessJob: routeMocks.enqueueCaptureAssetProcessJob,
  enqueueKnowledgeIngestJob: routeMocks.enqueueKnowledgeIngestJob,
}));

vi.mock("@/lib/operations/job-queue", () => ({
  getOperationJobsByIds: routeMocks.getOperationJobsByIds,
  projectOperationJobStatus: routeMocks.projectOperationJobStatus,
}));

import { GET, POST } from "@/app/api/capture/route";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "capture-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const context = {
  tenantId: "tenant-a",
  actorId,
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: authUserId,
    email: actorId,
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const requestActorBinding = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: [actorId],
  readableOwnerActorIds: [canonicalActorId, actorId],
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.canonicalRequestActorBindingFromSecurityContext
    .mockReset()
    .mockReturnValue(requestActorBinding);
  routeMocks.captureExecutionScopeFromSecurityContext
    .mockReset()
    .mockReturnValue({});
  routeMocks.listCaptureAssets.mockReset().mockResolvedValue([]);
  routeMocks.saveCaptureAsset.mockReset();
  routeMocks.updateCaptureAssetStatus.mockReset();
  routeMocks.enqueueCaptureAssetProcessJob.mockReset();
  routeMocks.enqueueKnowledgeIngestJob.mockReset();
  routeMocks.getOperationJobsByIds.mockReset().mockResolvedValue([]);
  routeMocks.projectOperationJobStatus.mockReset().mockImplementation((job) => ({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.payload?.progress || {},
  }));
});

describe("request-bound Capture asset collection route", () => {
  it("passes the authenticated actor binding only to the asset list", async () => {
    const response = await GET(
      new Request("http://localhost/api/capture?limit=20"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
    expect(routeMocks.listCaptureAssets).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId,
      requestActorBinding,
    }, 20);
    expect(routeMocks.getOperationJobsByIds).toHaveBeenCalledWith([], {
      tenantId: context.tenantId,
    });
  });

  it("returns exact-owner processing progress without job payload content", async () => {
    routeMocks.listCaptureAssets.mockResolvedValueOnce([
      { id: "asset-a", manageable: true, ingestJobId: "job-a" },
      { id: "asset-b", manageable: false, ingestJobId: "job-b" },
    ]);
    routeMocks.getOperationJobsByIds.mockResolvedValueOnce([{
      id: "job-a",
      type: "capture.asset.process",
      status: "running",
      payload: {
        actorId,
        request: { note: "private transcript content" },
        progress: { stage: "embedding", chunkCount: 8 },
      },
    }]);

    const response = await GET(new Request("http://localhost/api/capture"));
    const body = await response.json();

    expect(routeMocks.getOperationJobsByIds).toHaveBeenCalledWith(["job-a"], {
      tenantId: context.tenantId,
    });
    expect(body.processingJobs).toEqual([{
      assetId: "asset-a",
      id: "job-a",
      type: "capture.asset.process",
      status: "running",
      progress: { stage: "embedding", chunkCount: 8 },
    }]);
    expect(JSON.stringify(body.processingJobs)).not.toContain("private transcript");
  });

  it("does not derive or pass a request-read binding through POST", async () => {
    const form = new FormData();
    const response = await POST(new Request("http://localhost/api/capture", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(400);
    expect(routeMocks.authorizeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeMutationCapability: "capture.submit",
      }),
    );
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
    expect(routeMocks.listCaptureAssets).not.toHaveBeenCalled();
  });

  it("stores an uploaded transcript and queues extraction without reading it synchronously", async () => {
    const stored = {
      id: "capture_asset_a",
      tenantId: context.tenantId,
      actorId,
      filename: "ICT lesson.vtt",
      mediaType: "text/vtt",
      extension: "vtt",
      byteCount: 22,
      contentSha256: "a".repeat(64),
      storageKind: "database",
      status: "stored",
      extractionStatus: "pending",
      tags: ["ict"],
      metadata: {},
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    const job = {
      id: "job-a",
      type: "capture.asset.process",
      status: "queued",
      payload: { actorId, progress: { stage: "queued" } },
    };
    routeMocks.saveCaptureAsset.mockResolvedValueOnce(stored);
    routeMocks.enqueueCaptureAssetProcessJob.mockResolvedValueOnce(job);
    routeMocks.updateCaptureAssetStatus.mockResolvedValueOnce({
      ...stored,
      status: "queued",
      ingestJobId: job.id,
    });
    const form = new FormData();
    form.set("file", new File([
      "WEBVTT\n\n00:00.000 --> 00:02.000\nLiquidity",
    ], "ICT lesson.vtt", { type: "text/vtt" }));
    form.set("title", "ICT liquidity lesson");
    form.set("tags", "ict, liquidity");

    const response = await POST(new Request("http://localhost/api/capture", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(202);
    expect(routeMocks.saveCaptureAsset).toHaveBeenCalledOnce();
    expect(routeMocks.enqueueCaptureAssetProcessJob).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: context.tenantId,
        actorId,
        request: {
          assetId: stored.id,
          title: "ICT liquidity lesson",
          tags: ["ict", "liquidity"],
        },
      }),
    );
    expect(routeMocks.enqueueKnowledgeIngestJob).not.toHaveBeenCalled();
    expect(routeMocks.updateCaptureAssetStatus).toHaveBeenCalledWith(
      stored.id,
      expect.objectContaining({ tenantId: context.tenantId, actorId }),
      {
        status: "queued",
        extractionStatus: "pending",
        ingestJobId: job.id,
        clearExtractionReceipt: true,
      },
    );
  });

  it("keeps manual notes on the existing knowledge ingestion job", async () => {
    const job = {
      id: "job-note",
      type: "knowledge.ingest",
      status: "queued",
      payload: { actorId, progress: { stage: "queued" } },
    };
    routeMocks.enqueueKnowledgeIngestJob.mockResolvedValueOnce(job);
    const form = new FormData();
    form.set("content", "A manual observation about liquidity.");
    form.set("title", "Liquidity note");

    const response = await POST(new Request("http://localhost/api/capture", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(202);
    expect(routeMocks.enqueueKnowledgeIngestJob).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          title: "Liquidity note",
          content: "A manual observation about liquidity.",
          source: "capture://quick-note",
          sourceType: "manual",
          tags: [],
        },
      }),
    );
    expect(routeMocks.saveCaptureAsset).not.toHaveBeenCalled();
    expect(routeMocks.enqueueCaptureAssetProcessJob).not.toHaveBeenCalled();
  });

  it("rejects an offline retry that is not bound to the current owner", async () => {
    const response = await POST(new Request("http://localhost/api/capture", {
      method: "POST",
      headers: {
        "idempotency-key": "capture-offline-abcdefghijklmnopqrstuvwx",
        "x-omni-correlation-id":
          "capture-offline-abcdefghijklmnopqrstuvwx",
      },
      body: new FormData(),
    }));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.captureExecutionScopeFromSecurityContext).not.toHaveBeenCalled();
  });
});
