import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  class CaptureAssetError extends Error {
    constructor(message: string, public readonly status = 400) {
      super(message);
      this.name = "CaptureAssetError";
    }
  }
  class CaptureAssetReadConflictError extends Error {
    constructor(message = "Capture asset ownership is ambiguous.") {
      super(message);
      this.name = "CaptureAssetReadConflictError";
    }
  }
  class CaptureAssetContentIntegrityError extends Error {
    constructor(message = "Capture asset content failed integrity validation.") {
      super(message);
      this.name = "CaptureAssetContentIntegrityError";
    }
  }
  class CaptureAssetContentNotReadyError extends Error {
    constructor(message = "Captured file content is still being prepared.") {
      super(message);
      this.name = "CaptureAssetContentNotReadyError";
    }
  }
  class CaptureAssetExtractionIntegrityError extends Error {
    constructor(message = "Capture asset extraction evidence failed integrity validation.") {
      super(message);
      this.name = "CaptureAssetExtractionIntegrityError";
    }
  }
  return {
    CaptureAssetContentIntegrityError,
    CaptureAssetContentNotReadyError,
    CaptureAssetExtractionIntegrityError,
    CaptureAssetError,
    CaptureAssetReadConflictError,
    authorizeRequest: vi.fn(),
    canonicalRequestActorBindingFromSecurityContext: vi.fn(),
    deleteCaptureAssetWithKnowledge: vi.fn(),
    getCaptureAsset: vi.fn(),
    getCaptureAssetForRequest: vi.fn(),
    getCaptureAssetContent: vi.fn(),
    getCaptureAssetContentForRequest: vi.fn(),
    getCaptureAssetExtractionForRequest: vi.fn(),
  };
});

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

vi.mock("@/lib/capture/assets", () => ({
  CaptureAssetContentIntegrityError:
    routeMocks.CaptureAssetContentIntegrityError,
  CaptureAssetContentNotReadyError:
    routeMocks.CaptureAssetContentNotReadyError,
  CaptureAssetExtractionIntegrityError:
    routeMocks.CaptureAssetExtractionIntegrityError,
  CaptureAssetError: routeMocks.CaptureAssetError,
  CaptureAssetReadConflictError: routeMocks.CaptureAssetReadConflictError,
  getCaptureAsset: routeMocks.getCaptureAsset,
  getCaptureAssetForRequest: routeMocks.getCaptureAssetForRequest,
  getCaptureAssetContent: routeMocks.getCaptureAssetContent,
  getCaptureAssetContentForRequest:
    routeMocks.getCaptureAssetContentForRequest,
  getCaptureAssetExtractionForRequest:
    routeMocks.getCaptureAssetExtractionForRequest,
  updateCaptureAssetStatus: vi.fn(),
}));

vi.mock("@/lib/capture/deletion", () => ({
  deleteCaptureAssetWithKnowledge:
    routeMocks.deleteCaptureAssetWithKnowledge,
}));

vi.mock("@/lib/capture/execution-scope", () => ({
  captureExecutionScopeFromSecurityContext: vi.fn(),
}));

vi.mock("@/lib/capture/files", () => ({
  CaptureFileError: class CaptureFileError extends Error {},
  captureTitle: vi.fn(),
  extractCaptureFile: vi.fn(),
}));

vi.mock("@/lib/operations/background-jobs", () => ({
  BackgroundJobIdempotencyConflictError:
    class BackgroundJobIdempotencyConflictError extends Error {},
  enqueueCaptureAssetProcessJob: vi.fn(),
  enqueueKnowledgeIngestJob: vi.fn(),
}));

vi.mock("@/lib/operations/job-queue", () => ({
  cancelOperationJobByDedupeKey: vi.fn(),
  getOperationJob: vi.fn(),
  projectOperationJobStatus: vi.fn(),
}));

import { DELETE, GET, POST } from "@/app/api/capture/assets/[id]/route";

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
const asset = {
  id: "asset-a",
  tenantId: "tenant-a",
  actorId,
  filename: "asset-a.txt",
  mediaType: "text/plain",
  extension: "txt",
  byteCount: 4,
  contentSha256: "a".repeat(64),
  storageKind: "database" as const,
  status: "stored" as const,
  extractionStatus: "pending" as const,
  tags: [],
  metadata: {},
  createdAt: "2026-09-04T10:00:00.000Z",
  updatedAt: "2026-09-04T10:00:00.000Z",
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.canonicalRequestActorBindingFromSecurityContext
    .mockReset()
    .mockReturnValue(requestActorBinding);
  routeMocks.getCaptureAsset.mockReset();
  routeMocks.getCaptureAssetForRequest.mockReset().mockResolvedValue({
    ...asset,
    contentAvailable: true,
    indexable: true,
    manageable: true,
  });
  routeMocks.getCaptureAssetContent.mockReset().mockResolvedValue({
    asset,
    bytes: Buffer.from("test"),
  });
  routeMocks.getCaptureAssetContentForRequest.mockReset().mockResolvedValue({
    asset,
    bytes: Buffer.from("test"),
  });
  routeMocks.getCaptureAssetExtractionForRequest.mockReset().mockResolvedValue({
    evidenceAvailable: true,
    units: [{ index: 0, evidenceUnitId: "evidence-a" }],
  });
});

describe("request-bound Capture asset detail route", () => {
  it("uses the authenticated owner binding for metadata", async () => {
    const response = await GET(
      new Request("http://localhost/api/capture/assets/asset-a"),
      { params: Promise.resolve({ id: "asset-a" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.getCaptureAssetForRequest).toHaveBeenCalledWith(
      "asset-a",
      {
        tenantId: "tenant-a",
        actorId,
        requestActorBinding,
      },
    );
    expect(routeMocks.getCaptureAsset).not.toHaveBeenCalled();
    expect(routeMocks.getCaptureAssetContent).not.toHaveBeenCalled();
  });

  it("uses the authenticated owner binding for verified byte reads", async () => {
    const response = await GET(
      new Request("http://localhost/api/capture/assets/asset-a?content=1"),
      { params: Promise.resolve({ id: "asset-a" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("etag")).toBe(`"${"a".repeat(64)}"`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.getCaptureAssetContentForRequest).toHaveBeenCalledWith(
      "asset-a",
      {
        tenantId: "tenant-a",
        actorId,
        requestActorBinding,
      },
    );
    expect(routeMocks.getCaptureAssetForRequest).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
    expect(routeMocks.getCaptureAssetContent).not.toHaveBeenCalled();
  });

  it.each([
    "video/mp4",
    "video/webm",
    "video/ogg",
    "video/quicktime",
    "video/x-m4v",
    "video/mp4; codecs=avc1",
  ])("serves a validated %s asset inline for private playback", async (mediaType) => {
    routeMocks.getCaptureAssetContentForRequest.mockResolvedValueOnce({
      asset: { ...asset, filename: "private-video.mp4", mediaType },
      bytes: Buffer.from("test"),
    });

    const response = await GET(
      new Request("http://localhost/api/capture/assets/asset-a?content=1"),
      { params: Promise.resolve({ id: "asset-a" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      "inline; filename*=UTF-8''private-video.mp4",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("forces an unsafe media type to download", async () => {
    routeMocks.getCaptureAssetContentForRequest.mockResolvedValueOnce({
      asset: { ...asset, filename: "unsafe.svg", mediaType: "image/svg+xml" },
      bytes: Buffer.from("test"),
    });

    const response = await GET(
      new Request("http://localhost/api/capture/assets/asset-a?content=1"),
      { params: Promise.resolve({ id: "asset-a" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''unsafe.svg",
    );
  });

  it("returns integrity-checked structured evidence only when requested", async () => {
    const response = await GET(
      new Request("http://localhost/api/capture/assets/asset-a?extraction=1"),
      { params: Promise.resolve({ id: "asset-a" }) },
    );

    expect(response.status).toBe(200);
    expect((await response.json()).extraction).toMatchObject({
      evidenceAvailable: true,
      units: [{ evidenceUnitId: "evidence-a" }],
    });
    expect(routeMocks.getCaptureAssetExtractionForRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "asset-a" }),
      { tenantId: "tenant-a", actorId, requestActorBinding },
    );
  });

  it("returns a private conflict when request ownership cannot be validated", async () => {
    routeMocks.getCaptureAssetForRequest.mockRejectedValueOnce(
      new routeMocks.CaptureAssetReadConflictError("private detail"),
    );

    const response = await GET(
      new Request("http://localhost/api/capture/assets/asset-a"),
      { params: Promise.resolve({ id: "asset-a" }) },
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Captured file metadata could not be resolved safely.",
    });
  });

  it("returns a private conflict when stored bytes fail verification", async () => {
    routeMocks.getCaptureAssetContentForRequest.mockRejectedValueOnce(
      new routeMocks.CaptureAssetContentIntegrityError(),
    );

    const response = await GET(
      new Request("http://localhost/api/capture/assets/asset-a?content=1"),
      { params: Promise.resolve({ id: "asset-a" }) },
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Captured file content could not be verified safely.",
    });
  });

  it("returns retry guidance while private source bytes are being prepared", async () => {
    routeMocks.getCaptureAssetContentForRequest.mockRejectedValueOnce(
      new routeMocks.CaptureAssetContentNotReadyError(),
    );

    const response = await GET(
      new Request("http://localhost/api/capture/assets/asset-a?content=1"),
      { params: Promise.resolve({ id: "asset-a" }) },
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Captured file content is still being prepared.",
    });
  });

  it("uses a content-specific private conflict for an unsafe byte owner", async () => {
    routeMocks.getCaptureAssetContentForRequest.mockRejectedValueOnce(
      new routeMocks.CaptureAssetReadConflictError("private content"),
    );

    const response = await GET(
      new Request("http://localhost/api/capture/assets/asset-a?content=1"),
      { params: Promise.resolve({ id: "asset-a" }) },
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Captured file content could not be resolved safely.",
    });
  });
});

describe("Capture asset deletion route", () => {
  const owner = { tenantId: context.tenantId, actorId };
  const route = { params: Promise.resolve({ id: asset.id }) };

  function deleteRequest(headers: Record<string, string> = { "idempotency-key": "delete-asset-1" }) {
    return new Request(`http://localhost/api/capture/assets/${asset.id}`, {
      method: "DELETE",
      headers,
    });
  }

  beforeEach(() => {
    routeMocks.getCaptureAsset.mockResolvedValue(asset);
    routeMocks.deleteCaptureAssetWithKnowledge
      .mockReset()
      .mockResolvedValue({ documents: 1, memories: 0 });
  });

  it("deletes the exact file it previewed through the asset service", async () => {
    const response = await DELETE(deleteRequest(), route);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.getCaptureAsset).toHaveBeenCalledWith(asset.id, owner);
    expect(routeMocks.deleteCaptureAssetWithKnowledge).toHaveBeenCalledTimes(1);
    expect(routeMocks.deleteCaptureAssetWithKnowledge).toHaveBeenCalledWith(asset, {
      ...owner,
      executionScope: expect.objectContaining({
        purpose: "capture.asset.delete",
        correlationId: "delete-asset-1",
        causationId: asset.id,
      }),
    });
    const body = await response.json();
    expect(body).toMatchObject({
      deleted: true,
      forgotten: { documents: 1, memories: 0 },
      target: { kind: "asset", id: asset.id, contentSha256: asset.contentSha256 },
      serviceReceipt: { operation: "app.assets.delete", accessMode: "mutation" },
    });
    expect(body.serviceReceipt.idempotencyKeySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(routeMocks.canonicalRequestActorBindingFromSecurityContext).not.toHaveBeenCalled();
  });

  it("refuses a delete or re-index without an Idempotency-Key before it is authorized", async () => {
    const deletion = await DELETE(deleteRequest({}), route);
    const reindex = await POST(new Request(`http://localhost/api/capture/assets/${asset.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), route);

    expect(deletion.status).toBe(400);
    expect(reindex.status).toBe(400);
    expect(routeMocks.authorizeRequest).not.toHaveBeenCalled();
    expect(routeMocks.getCaptureAsset).not.toHaveBeenCalled();
    expect(routeMocks.deleteCaptureAssetWithKnowledge).not.toHaveBeenCalled();
  });

  it("deletes nothing for a file the owner does not have", async () => {
    routeMocks.getCaptureAsset.mockResolvedValue(undefined);

    const response = await DELETE(deleteRequest(), route);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Captured file not found." });
    expect(routeMocks.deleteCaptureAssetWithKnowledge).not.toHaveBeenCalled();
  });

  it("reads no file for an id the services would change", async () => {
    for (const id of [`${asset.id} `, "a".repeat(201)]) {
      const response = await DELETE(deleteRequest(), { params: Promise.resolve({ id }) });

      expect(response.status, id).toBe(404);
    }
    expect(routeMocks.getCaptureAsset).not.toHaveBeenCalled();
  });

  it("answers not found when the file is gone by the time it is deleted", async () => {
    routeMocks.getCaptureAsset
      .mockResolvedValueOnce(asset)
      .mockResolvedValueOnce(asset)
      .mockResolvedValueOnce(undefined);

    const response = await DELETE(deleteRequest(), route);

    expect(response.status).toBe(404);
    expect(routeMocks.deleteCaptureAssetWithKnowledge).not.toHaveBeenCalled();
  });

  it("refuses to delete a file that changed after its preview", async () => {
    routeMocks.getCaptureAsset
      .mockResolvedValueOnce(asset)
      .mockResolvedValueOnce({ ...asset, contentSha256: "b".repeat(64) });

    const response = await DELETE(deleteRequest(), route);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Asset deletion target changed after preview; review the exact target again.",
    });
    expect(routeMocks.deleteCaptureAssetWithKnowledge).not.toHaveBeenCalled();
  });
});
