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
  return {
    CaptureAssetContentIntegrityError,
    CaptureAssetError,
    CaptureAssetReadConflictError,
    authorizeRequest: vi.fn(),
    canonicalRequestActorBindingFromSecurityContext: vi.fn(),
    deleteCaptureAssetWithKnowledge: vi.fn(),
    getCaptureAsset: vi.fn(),
    getCaptureAssetForRequest: vi.fn(),
    getCaptureAssetContent: vi.fn(),
    getCaptureAssetContentForRequest: vi.fn(),
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
  CaptureAssetError: routeMocks.CaptureAssetError,
  CaptureAssetReadConflictError: routeMocks.CaptureAssetReadConflictError,
  getCaptureAsset: routeMocks.getCaptureAsset,
  getCaptureAssetForRequest: routeMocks.getCaptureAssetForRequest,
  getCaptureAssetContent: routeMocks.getCaptureAssetContent,
  getCaptureAssetContentForRequest:
    routeMocks.getCaptureAssetContentForRequest,
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
  enqueueKnowledgeIngestJob: vi.fn(),
}));

vi.mock("@/lib/operations/job-queue", () => ({
  cancelOperationJobByDedupeKey: vi.fn(),
  getOperationJob: vi.fn(),
  projectOperationJobStatus: vi.fn(),
}));

import { GET } from "@/app/api/capture/assets/[id]/route";

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
