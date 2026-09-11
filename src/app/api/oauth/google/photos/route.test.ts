import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  captureExecutionScopeFromSecurityContext: vi.fn(),
  deleteImportedGooglePhotos: vi.fn(),
  googlePhotosPickerErrorResponse: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorizeRequest,
}));

vi.mock("@/lib/capture/execution-scope", () => ({
  captureExecutionScopeFromSecurityContext:
    mocks.captureExecutionScopeFromSecurityContext,
}));

vi.mock("@/lib/connectors/google-photos-picker", () => ({
  deleteImportedGooglePhotos: mocks.deleteImportedGooglePhotos,
  googlePhotosPickerErrorResponse: mocks.googlePhotosPickerErrorResponse,
}));

import { DELETE } from "@/app/api/oauth/google/photos/route";

const security = {
  tenantId: "tenant-a",
  actorId: "owner-a",
  role: "admin" as const,
  source: "session" as const,
};
const executionScope = { correlationId: "delete-google-photos-a" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(security);
  mocks.captureExecutionScopeFromSecurityContext.mockReturnValue(executionScope);
  mocks.deleteImportedGooglePhotos.mockResolvedValue({
    assets: 2,
    documents: 3,
    memories: 4,
  });
});

describe("Google Photos imported-data deletion route", () => {
  it("requires high-risk authorization and exact actor-bound execution scope", async () => {
    const request = new Request("http://localhost/api/oauth/google/photos", {
      method: "DELETE",
    });
    const response = await DELETE(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledWith({
      request,
      action: "write.memory",
      resourceType: "knowledge",
      riskLevel: 3,
      metadata: {
        provider: "google",
        category: "photos",
        operation: "delete_source",
      },
    });
    expect(mocks.captureExecutionScopeFromSecurityContext).toHaveBeenCalledWith(
      security,
      request,
      "connector.google_photos.delete_imports",
    );
    expect(mocks.deleteImportedGooglePhotos).toHaveBeenCalledWith(
      { tenantId: "tenant-a", actorId: "owner-a" },
      executionScope,
    );
    await expect(response.json()).resolves.toEqual({
      deleted: { assets: 2, documents: 3, memories: 4 },
      source: "google:photos",
    });
  });
});
