import { beforeEach, describe, expect, it, vi } from "vitest";
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
});

describe("Google Photos import deletion", () => {
  it("deletes only exact-owner imported assets through Capture knowledge deletion", async () => {
    const asset = captureAsset({ ingestJobId: "job-photo-a" });
    mocks.listExactCaptureAssetsByMetadata
      .mockResolvedValueOnce([asset])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.getOperationJob.mockResolvedValue({ dedupeKey: "capture-job-dedupe" });
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
    expect(mocks.cancelOperationJobByDedupeKey).toHaveBeenCalledWith(
      "capture-job-dedupe",
      "Google Photos import deleted by its owner.",
      { tenantId: "tenant-a" },
    );
    expect(mocks.deleteKnowledgeDocumentsBySourcePrefix).toHaveBeenCalledWith(
      expect.stringMatching(/^google:photos:[a-f0-9]{16}:/),
      {
        tenantId: "tenant-a",
        actorId: "owner-a",
        invalidationScope: scope,
      },
    );
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

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchMock() {
  return vi.mocked(fetch);
}
