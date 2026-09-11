import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createExecutionScope } from "@/lib/security/execution-scope";

const mocks = vi.hoisted(() => {
  class CaptureAssetError extends Error {
    constructor(message: string, public readonly status = 400) {
      super(message);
      this.name = "CaptureAssetError";
    }
  }
  class BackgroundJobIdempotencyConflictError extends Error {
    constructor() {
      super("Idempotency conflict.");
      this.name = "BackgroundJobIdempotencyConflictError";
    }
  }
  return {
    BackgroundJobIdempotencyConflictError,
    CaptureAssetError,
    cancelOperationJobByDedupeKey: vi.fn(),
    deleteCaptureAssetWithKnowledge: vi.fn(),
    deleteKnowledgeDocumentsBySourcePrefix: vi.fn(),
    enqueueCaptureAssetProcessJob: vi.fn(),
    enqueueKnowledgeIngestJob: vi.fn(),
    extractCaptureFile: vi.fn(),
    getActiveGoogleWorkspaceAccess: vi.fn(),
    getOperationJob: vi.fn(),
    listExactCaptureAssetsByMetadata: vi.fn(),
    listOperationJobs: vi.fn(),
    projectOperationJobStatus: vi.fn((job: { id: string; status: string }) => ({
      id: job.id,
      status: job.status,
    })),
    saveCaptureAsset: vi.fn(),
    updateCaptureAssetStatus: vi.fn(),
  };
});

vi.mock("@/lib/connectors/google-workspace-access", () => ({
  getActiveGoogleWorkspaceAccess: mocks.getActiveGoogleWorkspaceAccess,
}));

vi.mock("@/lib/capture/assets", () => ({
  CaptureAssetError: mocks.CaptureAssetError,
  MAX_CAPTURE_ASSET_BYTES: 20 * 1024 * 1024,
  listExactCaptureAssetsByMetadata: mocks.listExactCaptureAssetsByMetadata,
  saveCaptureAsset: mocks.saveCaptureAsset,
  updateCaptureAssetStatus: mocks.updateCaptureAssetStatus,
}));

vi.mock("@/lib/capture/deletion", () => ({
  deleteCaptureAssetWithKnowledge: mocks.deleteCaptureAssetWithKnowledge,
}));

vi.mock("@/lib/capture/files", () => ({
  extractCaptureFile: mocks.extractCaptureFile,
}));

vi.mock("@/lib/operations/background-jobs", () => ({
  BackgroundJobIdempotencyConflictError:
    mocks.BackgroundJobIdempotencyConflictError,
  enqueueCaptureAssetProcessJob: mocks.enqueueCaptureAssetProcessJob,
  enqueueKnowledgeIngestJob: mocks.enqueueKnowledgeIngestJob,
}));

vi.mock("@/lib/operations/job-queue", () => ({
  cancelOperationJobByDedupeKey: mocks.cancelOperationJobByDedupeKey,
  getOperationJob: mocks.getOperationJob,
  listOperationJobs: mocks.listOperationJobs,
  projectOperationJobStatus: mocks.projectOperationJobStatus,
}));

vi.mock("@/lib/rag/store", () => ({
  deleteKnowledgeDocumentsBySourcePrefix:
    mocks.deleteKnowledgeDocumentsBySourcePrefix,
}));

import {
  GooglePhotosPickerError,
  createGooglePhotosPickerSession,
  deleteImportedGooglePhotos,
  importGooglePhotosPickerSelection,
} from "@/lib/connectors/google-photos-picker";
import { OAuthCredentialError } from "@/lib/connectors/oauth-store";

const identity = { tenantId: "tenant-a", actorId: "owner-a" };
const photoBytes = new Uint8Array([1, 2, 3, 4]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActiveGoogleWorkspaceAccess.mockResolvedValue({
    accessToken: "photos-access-token",
  });
  mocks.saveCaptureAsset.mockImplementation(async (input) => captureAsset({
    id: "capture_asset_photo_a",
    filename: input.filename,
    mediaType: input.mediaType,
    byteCount: input.bytes.byteLength,
    metadata: input.metadata,
  }));
  mocks.enqueueCaptureAssetProcessJob.mockResolvedValue({
    id: "job-photo-a",
    status: "queued",
  });
  mocks.updateCaptureAssetStatus.mockImplementation(async (_id, _owner, update) =>
    captureAsset({
      id: "capture_asset_photo_a",
      status: update.status,
      extractionStatus: update.extractionStatus,
      ingestJobId: update.ingestJobId,
    }));
  mocks.listExactCaptureAssetsByMetadata.mockResolvedValue([]);
  mocks.listOperationJobs.mockResolvedValue([]);
  mocks.cancelOperationJobByDedupeKey.mockResolvedValue([]);
  mocks.deleteKnowledgeDocumentsBySourcePrefix.mockResolvedValue({
    documents: 0,
    memories: 0,
  });
  mocks.deleteCaptureAssetWithKnowledge.mockResolvedValue({
    documents: 0,
    memories: 0,
  });
  vi.stubGlobal("fetch", vi.fn());
});

describe("Google Photos Picker access", () => {
  it("maps a missing Picker capability to the existing reconnect response", async () => {
    mocks.getActiveGoogleWorkspaceAccess.mockRejectedValue(
      new OAuthCredentialError(
        "Capability unavailable.",
        "capability_not_granted",
      ),
    );

    await expect(createGooglePhotosPickerSession(identity, 1)).rejects.toEqual(
      expect.objectContaining<Partial<GooglePhotosPickerError>>({
        status: 409,
        code: "photos_scope_required",
        reconnectRequired: true,
      }),
    );
    expect(mocks.getActiveGoogleWorkspaceAccess).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "owner-a",
      capability: "photos.pick",
    });
  });
});

describe("Google Photos durable imports", () => {
  it("downloads selected photo bytes with =d and returns only a private asset projection", async () => {
    const handle = await createHandle();
    installPhotoImportFetch();

    const result = await importGooglePhotosPickerSelection(
      identity,
      handle,
      executionScope(),
    );

    expect(fetchMock()).toHaveBeenCalledWith(
      "https://lh3.googleusercontent.com/private-photo=d",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer photos-access-token",
        }),
      }),
    );
    expect(mocks.saveCaptureAsset).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      actorId: "owner-a",
      bytes: photoBytes,
      mediaType: "image/jpeg",
      metadata: expect.objectContaining({
        importSource: "google_photos_picker",
        providerItemKey: expect.stringMatching(/^[a-f0-9]{40}$/),
      }),
    }));
    expect(result).toMatchObject({
      selected: 1,
      imported: 1,
      assets: [{
        id: "capture_asset_photo_a",
        jobId: "job-photo-a",
        filename: "portrait.jpg",
        byteCount: 4,
      }],
      skipped: [],
      sessionDeleted: true,
    });
    const publicJson = JSON.stringify(result);
    const persistedJson = JSON.stringify(mocks.saveCaptureAsset.mock.calls[0]?.[0]);
    expect(publicJson).not.toContain("baseUrl");
    expect(publicJson).not.toContain("googleusercontent.com");
    expect(publicJson).not.toContain("provider-photo-a");
    expect(publicJson).not.toContain("AQ_private");
    expect(persistedJson).not.toContain("googleusercontent.com");
    expect(persistedJson).not.toContain("provider-photo-a");
  });

  it("uses stable actor-bound correlation and idempotency values on replay", async () => {
    const handle = await createHandle();
    installPhotoImportFetch({ deleteSucceeds: false });
    mocks.listExactCaptureAssetsByMetadata
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([captureAsset({ ingestJobId: "job-photo-a" })]);

    const first = await importGooglePhotosPickerSelection(
      identity,
      handle,
      executionScope("request-one"),
    );
    const replay = await importGooglePhotosPickerSelection(
      identity,
      handle,
      executionScope("request-two"),
    );

    const firstSave = mocks.saveCaptureAsset.mock.calls[0]?.[0];
    const replayQueue = mocks.enqueueCaptureAssetProcessJob.mock.calls[1]?.[0];
    expect(firstSave.executionScope.correlationId).toBe(
      replayQueue.executionScope.correlationId,
    );
    expect(firstSave.executionScope.correlationId).toMatch(/^google-photos:[a-f0-9]{48}$/);
    expect(mocks.enqueueCaptureAssetProcessJob.mock.calls[0]?.[0].idempotencyKey)
      .toBe(mocks.enqueueCaptureAssetProcessJob.mock.calls[1]?.[0].idempotencyKey);
    expect(first.assets[0]?.id).toBe(replay.assets[0]?.id);
    expect(first.sessionDeleted).toBe(false);
    expect(replay.sessionDeleted).toBe(false);
    expect(mocks.listExactCaptureAssetsByMetadata).toHaveBeenCalledWith(
      identity,
      {
        field: "importSource",
        value: "google_photos_picker",
        secondary: {
          field: "providerItemKey",
          value: expect.stringMatching(/^[a-f0-9]{40}$/),
        },
        limit: 2,
      },
    );
    expect(fetchMock().mock.calls.filter(([url]) =>
      String(url) === "https://lh3.googleusercontent.com/private-photo=d"
    )).toHaveLength(1);
  });

  it("rejects a scope owned by another actor before reading provider content", async () => {
    await expect(importGooglePhotosPickerSelection(
      identity,
      "not-used",
      executionScope("request", "owner-b"),
    )).rejects.toThrow("does not match the authenticated actor");
    expect(fetchMock()).not.toHaveBeenCalled();
    expect(mocks.saveCaptureAsset).not.toHaveBeenCalled();
  });

  it("keeps the Picker session when the original exceeds the 20 MiB limit", async () => {
    const handle = await createHandle();
    installPhotoImportFetch({ declaredBytes: 20 * 1024 * 1024 + 1 });

    const result = await importGooglePhotosPickerSelection(
      identity,
      handle,
      executionScope(),
    );

    expect(result).toMatchObject({
      imported: 0,
      assets: [],
      skipped: [{ code: "photo_too_large" }],
      sessionDeleted: false,
    });
    expect(mocks.saveCaptureAsset).not.toHaveBeenCalled();
    expect(fetchMock().mock.calls.some(([url, init]) =>
      String(url).includes("/sessions/") && init?.method === "DELETE"
    )).toBe(false);
  });

  it("continues a transfer-capped batch without downloading a saved photo again", async () => {
    const handle = await createHandle();
    const largePhoto = new Uint8Array(13 * 1024 * 1024);
    mocks.listExactCaptureAssetsByMetadata
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([captureAsset({
        id: "capture_asset_photo_a",
        byteCount: largePhoto.byteLength,
        ingestJobId: "job-photo-a",
      })])
      .mockResolvedValueOnce([]);
    fetchMock().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sessions/picker-session-a") && init?.method === "GET") {
        return jsonResponse({ id: "picker-session-a", mediaItemsSet: true });
      }
      if (url.includes("/mediaItems?")) {
        return jsonResponse({ mediaItems: [
          providerPhoto(),
          providerPhoto("provider-photo-b", "private-photo-b", "second.jpg"),
        ] });
      }
      if (
        url === "https://lh3.googleusercontent.com/private-photo=d" ||
        url === "https://lh3.googleusercontent.com/private-photo-b=d"
      ) {
        return new Response(largePhoto, {
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(largePhoto.byteLength),
          },
        });
      }
      if (url.endsWith("/sessions/picker-session-a") && init?.method === "DELETE") {
        return jsonResponse({});
      }
      throw new Error(`Unexpected Google Photos request: ${url}`);
    });

    const first = await importGooglePhotosPickerSelection(
      identity,
      handle,
      executionScope("batch-one"),
    );
    const continuation = await importGooglePhotosPickerSelection(
      identity,
      handle,
      executionScope("batch-two"),
    );

    expect(first).toMatchObject({
      imported: 1,
      skipped: [{ filename: "second.jpg", code: "batch_transfer_limit" }],
      sessionDeleted: false,
    });
    expect(continuation).toMatchObject({
      imported: 2,
      skipped: [],
      sessionDeleted: true,
    });
    expect(fetchMock().mock.calls.filter(([url]) =>
      String(url) === "https://lh3.googleusercontent.com/private-photo=d"
    )).toHaveLength(1);
  });

  it("charges headerless stream chunks to the shared budget, cancels overflow, and stops transfers", async () => {
    const handle = await createHandle();
    const firstBytes = new Uint8Array(13 * 1024 * 1024);
    const overflowCanceled = vi.fn();
    let thirdPhotoDownloads = 0;
    mocks.listExactCaptureAssetsByMetadata.mockResolvedValue([]);
    fetchMock().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sessions/picker-session-a") && init?.method === "GET") {
        return jsonResponse({ id: "picker-session-a", mediaItemsSet: true });
      }
      if (url.includes("/mediaItems?")) {
        return jsonResponse({ mediaItems: [
          providerPhoto(),
          providerPhoto("provider-photo-b", "private-photo-b", "second.jpg"),
          providerPhoto("provider-photo-c", "private-photo-c", "third.jpg"),
        ] });
      }
      if (url === "https://lh3.googleusercontent.com/private-photo=d") {
        return new Response(headerlessStream([firstBytes]), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (url === "https://lh3.googleusercontent.com/private-photo-b=d") {
        return new Response(headerlessStream([
          new Uint8Array(8 * 1024 * 1024),
          new Uint8Array(4 * 1024 * 1024),
        ], overflowCanceled), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (url === "https://lh3.googleusercontent.com/private-photo-c=d") {
        thirdPhotoDownloads += 1;
        return new Response(photoBytes, {
          headers: { "content-type": "image/jpeg" },
        });
      }
      throw new Error(`Unexpected Google Photos request: ${url}`);
    });

    const result = await importGooglePhotosPickerSelection(
      identity,
      handle,
      executionScope("headerless-cap"),
    );

    expect(result).toMatchObject({
      imported: 1,
      skipped: [
        { filename: "second.jpg", code: "batch_transfer_limit" },
        { filename: "third.jpg", code: "batch_transfer_limit" },
      ],
      sessionDeleted: false,
    });
    expect(overflowCanceled).toHaveBeenCalledOnce();
    expect(thirdPhotoDownloads).toBe(0);
    expect(mocks.saveCaptureAsset).toHaveBeenCalledTimes(1);
  });

  it("reports selected videos as pending without downloading or queuing metadata", async () => {
    const handle = await createHandle();
    fetchMock().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sessions/picker-session-a") && init?.method === "GET") {
        return jsonResponse({ id: "picker-session-a", mediaItemsSet: true });
      }
      if (url.includes("/mediaItems?")) {
        return jsonResponse({ mediaItems: [providerVideo()] });
      }
      if (url.endsWith("/sessions/picker-session-a") && init?.method === "DELETE") {
        return jsonResponse({});
      }
      throw new Error(`Unexpected Google Photos request: ${url}`);
    });

    const result = await importGooglePhotosPickerSelection(
      identity,
      handle,
      executionScope("video-pending"),
    );

    expect(result).toMatchObject({
      selected: 1,
      imported: 0,
      assets: [],
      metadataOnly: [],
      skipped: [{ code: "video_import_pending" }],
      jobs: [],
      sessionDeleted: true,
    });
    expect(mocks.enqueueKnowledgeIngestJob).not.toHaveBeenCalled();
    expect(mocks.extractCaptureFile).not.toHaveBeenCalled();
    expect(fetchMock().mock.calls.some(([url]) =>
      String(url).includes("googleusercontent.com")
    )).toBe(false);
  });
});

describe("Google Photos import deletion", () => {
  it("deletes exact-owner assets and legacy video knowledge after validating their jobs", async () => {
    const asset = captureAsset({ ingestJobId: "job-photo-a" });
    mocks.listExactCaptureAssetsByMetadata
      .mockResolvedValueOnce([asset])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.getOperationJob.mockResolvedValue(captureProcessJob(asset));
    const videoJob = legacyVideoJob(identity, {
      id: "job-video-a",
      dedupeKey: "video-job-dedupe",
      status: "running",
    });
    mocks.listOperationJobs.mockResolvedValue([videoJob]);
    mocks.cancelOperationJobByDedupeKey
      .mockResolvedValueOnce([captureProcessJob(asset)])
      .mockResolvedValueOnce([videoJob]);
    mocks.deleteCaptureAssetWithKnowledge.mockResolvedValue({
      documents: 1,
      memories: 2,
    });
    mocks.deleteKnowledgeDocumentsBySourcePrefix.mockResolvedValue({
      documents: 3,
      memories: 4,
    });
    const scope = executionScope("delete-request");

    await expect(deleteImportedGooglePhotos(identity, scope)).resolves.toEqual({
      assets: 1,
      documents: 4,
      memories: 6,
      jobsCanceled: 2,
    });
    expect(mocks.listExactCaptureAssetsByMetadata).toHaveBeenCalledWith(
      identity,
      {
        field: "importSource",
        value: "google_photos_picker",
        limit: 100,
      },
    );
    expect(mocks.deleteCaptureAssetWithKnowledge).toHaveBeenCalledWith(
      asset,
      { ...identity, executionScope: scope },
    );
    expect(mocks.cancelOperationJobByDedupeKey).toHaveBeenNthCalledWith(
      1,
      "capture-job-dedupe",
      "Google Photos import deleted by its owner.",
      { tenantId: "tenant-a" },
    );
    expect(mocks.cancelOperationJobByDedupeKey).toHaveBeenNthCalledWith(
      2,
      "video-job-dedupe",
      "Google Photos import deleted by its owner.",
      { tenantId: "tenant-a" },
    );
    expect(mocks.deleteKnowledgeDocumentsBySourcePrefix).toHaveBeenCalledWith(
      legacyVideoSource(identity),
      {
        tenantId: "tenant-a",
        actorId: "owner-a",
        invalidationScope: scope,
      },
    );
  });

  it("does not cancel or delete jobs bound to another actor or another asset", async () => {
    const asset = captureAsset({ ingestJobId: "job-photo-a" });
    mocks.listExactCaptureAssetsByMetadata
      .mockResolvedValueOnce([asset])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.getOperationJob.mockResolvedValue(captureProcessJob(asset, {
      payload: {
        actorId: "owner-b",
        executionScope: executionScope("wrong-owner", "owner-b"),
        request: { assetId: asset.id },
      },
    }));
    mocks.listOperationJobs.mockResolvedValue([
      legacyVideoJob({ ...identity, actorId: "owner-b" }),
      legacyVideoJob(identity, {
        payload: {
          actorId: "owner-a",
          executionScope: executionScope("wrong-purpose"),
          request: {
            source: legacyVideoSource(identity),
            metadata: {
              provider: "google",
              category: "photos",
              mediaType: "photo",
              providerItemKey: providerKey("provider-video-a"),
            },
          },
        },
      }),
    ]);

    await expect(deleteImportedGooglePhotos(
      identity,
      executionScope("isolated-delete"),
    )).resolves.toEqual({
      assets: 1,
      documents: 0,
      memories: 0,
      jobsCanceled: 0,
    });

    expect(mocks.cancelOperationJobByDedupeKey).not.toHaveBeenCalled();
    expect(mocks.deleteKnowledgeDocumentsBySourcePrefix).not.toHaveBeenCalled();
  });

  it("targets a full actor-bound source exactly and never another actor's source", async () => {
    const otherIdentity = { ...identity, actorId: "owner-b" };
    const ownerJob = legacyVideoJob(identity, { sourceVersion: "current" });
    const otherJob = legacyVideoJob(otherIdentity, { sourceVersion: "current" });
    mocks.listOperationJobs.mockResolvedValue([ownerJob, otherJob]);
    mocks.deleteKnowledgeDocumentsBySourcePrefix.mockResolvedValue({
      documents: 1,
      memories: 1,
    });
    mocks.listExactCaptureAssetsByMetadata.mockResolvedValue([]);

    await deleteImportedGooglePhotos(identity, executionScope("full-source-delete"));

    const deletedSource = mocks.deleteKnowledgeDocumentsBySourcePrefix.mock.calls[0]?.[0];
    expect(deletedSource).toBe(currentVideoSource(identity));
    expect(deletedSource).toMatch(/^google:photos:[a-f0-9]{64}:[a-f0-9]{40}$/);
    expect(deletedSource).not.toBe(currentVideoSource(otherIdentity));
    expect(mocks.deleteKnowledgeDocumentsBySourcePrefix).toHaveBeenCalledTimes(1);
  });
});

async function createHandle() {
  fetchMock().mockResolvedValueOnce(jsonResponse({
    id: "picker-session-a",
    pickerUri: "https://photos.google.com/picker/session-a",
    expireTime: new Date(Date.now() + 60_000).toISOString(),
    mediaItemsSet: false,
  }));
  const session = await createGooglePhotosPickerSession(identity, 1);
  return session.handle;
}

function installPhotoImportFetch(options: {
  declaredBytes?: number;
  deleteSucceeds?: boolean;
} = {}) {
  fetchMock().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/sessions/picker-session-a") && init?.method === "GET") {
      return jsonResponse({ id: "picker-session-a", mediaItemsSet: true });
    }
    if (url.includes("/mediaItems?")) {
      return jsonResponse({ mediaItems: [providerPhoto()] });
    }
    if (url === "https://lh3.googleusercontent.com/private-photo=d") {
      return new Response(photoBytes, {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(options.declaredBytes ?? photoBytes.byteLength),
        },
      });
    }
    if (url.endsWith("/sessions/picker-session-a") && init?.method === "DELETE") {
      return options.deleteSucceeds === false
        ? jsonResponse({ error: { status: "INTERNAL" } }, 500)
        : jsonResponse({});
    }
    throw new Error(`Unexpected Google Photos request: ${url}`);
  });
}

function providerPhoto(
  id = "provider-photo-a",
  path = "private-photo",
  filename = "portrait.jpg",
) {
  return {
    id,
    type: "PHOTO",
    createTime: "2026-09-11T06:00:00.000Z",
    mediaFile: {
      baseUrl: `https://lh3.googleusercontent.com/${path}`,
      mimeType: "image/jpeg",
      filename,
      mediaFileMetadata: { width: 1200, height: 1600 },
    },
  };
}

function providerVideo() {
  return {
    id: "provider-video-a",
    type: "VIDEO",
    createTime: "2026-09-11T06:00:00.000Z",
    mediaFile: {
      baseUrl: "https://lh3.googleusercontent.com/private-video",
      mimeType: "video/mp4",
      filename: "clip.mp4",
      mediaFileMetadata: {
        width: 1920,
        height: 1080,
        videoMetadata: { processingStatus: "READY" },
      },
    },
  };
}

function headerlessStream(chunks: Uint8Array[], onCancel = vi.fn()) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
    cancel(reason) {
      onCancel(reason);
    },
  }, { highWaterMark: 0 });
}

function captureAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: "capture_asset_photo_a",
    tenantId: "tenant-a",
    actorId: "owner-a",
    filename: "portrait.jpg",
    mediaType: "image/jpeg",
    extension: "jpg",
    byteCount: 4,
    contentSha256: "a".repeat(64),
    storageKind: "database",
    status: "stored",
    extractionStatus: "pending",
    tags: ["connected-source", "google", "photos", "photo"],
    metadata: {
      importSource: "google_photos_picker",
      providerCreatedAt: "2026-09-11T06:00:00.000Z",
      width: 1200,
      height: 1600,
    },
    createdAt: "2026-09-11T06:00:00.000Z",
    updatedAt: "2026-09-11T06:00:00.000Z",
    ...overrides,
  };
}

function executionScope(correlationId = "photos-request", actorId = "owner-a") {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: actorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorId,
    correlationId,
    purpose: "connector.google_photos.test",
  });
}

function captureProcessJob(
  asset: ReturnType<typeof captureAsset>,
  overrides: Record<string, unknown> = {},
) {
  const ingestJobId = "ingestJobId" in asset ? asset.ingestJobId : undefined;
  return {
    id: String(ingestJobId || "job-photo-a"),
    tenantId: "tenant-a",
    type: "capture.asset.process",
    status: "queued",
    payload: {
      actorId: "owner-a",
      executionScope: executionScope("capture-job"),
      request: { assetId: asset.id },
    },
    dedupeKey: "capture-job-dedupe",
    priority: 1,
    attempt: 0,
    maxAttempts: 3,
    runAt: "2026-09-11T06:00:00.000Z",
    createdAt: "2026-09-11T06:00:00.000Z",
    updatedAt: "2026-09-11T06:00:00.000Z",
    ...overrides,
  };
}

function legacyVideoJob(
  owner = identity,
  overrides: Record<string, unknown> & {
    sourceVersion?: "legacy" | "current";
  } = {},
) {
  const sourceVersion = overrides.sourceVersion || "legacy";
  const source = sourceVersion === "current"
    ? currentVideoSource(owner)
    : legacyVideoSource(owner);
  const jobOverrides = { ...overrides };
  delete jobOverrides.sourceVersion;
  return {
    id: "job-video-a",
    tenantId: owner.tenantId,
    type: "knowledge.ingest",
    status: "completed",
    payload: {
      actorId: owner.actorId,
      executionScope: createExecutionScope({
        tenantId: owner.tenantId,
        initiatingActorId: owner.actorId,
        executingPrincipalType: "user",
        executingPrincipalId: owner.actorId,
        correlationId: `video-${owner.actorId}`,
        purpose: "connector.google_photos.persist_selection",
      }),
      request: {
        source,
        metadata: {
          provider: "google",
          category: "photos",
          mediaType: "video",
          providerItemKey: providerKey("provider-video-a"),
        },
      },
    },
    dedupeKey: `video-job-dedupe-${owner.actorId}`,
    priority: 1,
    attempt: 0,
    maxAttempts: 3,
    runAt: "2026-09-11T06:00:00.000Z",
    createdAt: "2026-09-11T06:00:00.000Z",
    updatedAt: "2026-09-11T06:00:00.000Z",
    ...jobOverrides,
  };
}

function providerKey(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 40);
}

function legacyVideoSource(owner = identity) {
  const actorKey = createHash("sha256")
    .update(`${owner.tenantId}:${owner.actorId}`)
    .digest("hex")
    .slice(0, 16);
  return `google:photos:${actorKey}:${providerKey("provider-video-a")}`;
}

function currentVideoSource(owner = identity) {
  const actorKey = createHash("sha256")
    .update(`${owner.tenantId}\0${owner.actorId}`)
    .digest("hex");
  return `google:photos:${actorKey}:${providerKey("provider-video-a")}`;
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchMock() {
  return vi.mocked(fetch);
}
