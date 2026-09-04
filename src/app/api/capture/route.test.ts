import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  canonicalRequestActorBindingFromSecurityContext: vi.fn(),
  captureExecutionScopeFromSecurityContext: vi.fn(),
  listCaptureAssets: vi.fn(),
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
  saveCaptureAsset: vi.fn(),
  updateCaptureAssetStatus: vi.fn(),
}));

vi.mock("@/lib/capture/files", () => ({
  CaptureFileError: class CaptureFileError extends Error {},
  extractCaptureFile: vi.fn(),
}));

vi.mock("@/lib/operations/background-jobs", () => ({
  BackgroundJobIdempotencyConflictError:
    class BackgroundJobIdempotencyConflictError extends Error {},
  enqueueKnowledgeIngestJob: vi.fn(),
}));

vi.mock("@/lib/operations/job-queue", () => ({
  projectOperationJobStatus: vi.fn(),
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
  });

  it("does not derive or pass a request-read binding through POST", async () => {
    const form = new FormData();
    const response = await POST(new Request("http://localhost/api/capture", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(400);
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
    expect(routeMocks.listCaptureAssets).not.toHaveBeenCalled();
  });
});
