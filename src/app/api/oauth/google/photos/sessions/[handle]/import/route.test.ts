import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  captureExecutionScopeFromSecurityContext: vi.fn(),
  googlePhotosPickerErrorResponse: vi.fn(),
  importGooglePhotosPickerSelection: vi.fn(),
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
  googlePhotosPickerErrorResponse: mocks.googlePhotosPickerErrorResponse,
  importGooglePhotosPickerSelection: mocks.importGooglePhotosPickerSelection,
}));

import { POST } from "@/app/api/oauth/google/photos/sessions/[handle]/import/route";

const security = {
  tenantId: "tenant-a",
  actorId: "owner-a",
  role: "admin" as const,
  source: "session" as const,
};
const executionScope = {
  version: 1,
  tenantId: "tenant-a",
  initiatingActorId: "owner-a",
  executingPrincipalType: "user",
  executingPrincipalId: "owner-a",
  workspaceId: null,
  projectId: null,
  missionId: null,
  delegationId: null,
  correlationId: "photos-request-a",
  causationId: null,
  contextGrantIds: [],
  capabilityGrantIds: [],
  purpose: "connector.google_photos.import_selection",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(security);
  mocks.captureExecutionScopeFromSecurityContext.mockReturnValue(executionScope);
  mocks.importGooglePhotosPickerSelection.mockResolvedValue({
    selected: 1,
    imported: 1,
    assets: [{ id: "capture_asset_photo_a" }],
    metadataOnly: [],
    skipped: [],
    jobs: [{ id: "job-photo-a", status: "queued" }],
    selectionTruncated: false,
    sessionDeleted: true,
  });
});

describe("Google Photos import route", () => {
  it("creates an exact authenticated request scope before durable import", async () => {
    const request = new Request(
      "http://localhost/api/oauth/google/photos/sessions/handle-a/import",
      { method: "POST" },
    );
    const response = await POST(request, {
      params: Promise.resolve({ handle: "handle-a" }),
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledWith({
      request,
      action: "write.memory",
      resourceType: "google_photos_picker",
      metadata: {
        provider: "google",
        category: "photos",
        operation: "import_selection",
      },
    });
    expect(mocks.captureExecutionScopeFromSecurityContext).toHaveBeenCalledWith(
      security,
      request,
      "connector.google_photos.import_selection",
    );
    expect(mocks.importGooglePhotosPickerSelection).toHaveBeenCalledWith(
      { tenantId: "tenant-a", actorId: "owner-a" },
      "handle-a",
      executionScope,
      request.signal,
    );
  });
});
