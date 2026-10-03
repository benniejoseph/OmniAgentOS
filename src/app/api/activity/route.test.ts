import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityResponse } from "@/lib/activity/contracts";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(), forbiddenResponse: vi.fn(), canPerform: vi.fn(),
  getActivity: vi.fn(), enterRequestScope: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: (request: Request) => Promise<Response>) => async (request: Request) => {
    mocks.enterRequestScope(request);
    return handler(request);
  },
}));
vi.mock("@/lib/security/context", () => ({ canPerform: mocks.canPerform }));
vi.mock("@/lib/security/guard", () => ({ authorizeRequest: mocks.authorizeRequest, forbiddenResponse: mocks.forbiddenResponse }));
vi.mock("@/lib/activity/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/activity/service")>()),
  getActivity: mocks.getActivity,
}));

import * as route from "@/app/api/activity/route";
import { ActivityRequestError } from "@/lib/activity/service";

const actorId = "owner@example.test";
const authUserId = "11111111-1111-4111-8111-111111111111";
const context = {
  tenantId: "tenant-a", actorId, role: "operator", source: "session",
  auth: { userId: authUserId, email: actorId, sessionId: "session-a", tenantName: "Tenant A" },
};
const empty: ActivityResponse = {
  schemaVersion: 1, contract: "asael-activity:1", generatedAt: "2026-10-03T10:00:00.000Z",
  state: "ready", group: "all", items: [], counts: { working: 0, needs_you: 0, updates: 0, history: 0 },
  coverage: {
    runs: { state: "ready", limit: 100, visibleCount: 0 },
    approvals: { state: "ready", limit: 100, visibleCount: 0 },
    notifications: { state: "ready", limit: 100, visibleCount: 0 },
  },
  window: { bounded: true, limitPerSource: 100 }, page: { limit: 25, nextCursor: null, hasMore: false },
};

describe("Activity GET route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue(context);
    mocks.canPerform.mockImplementation((role: string, action: string) => action === "manage.workflow" && role !== "viewer");
    mocks.forbiddenResponse.mockImplementation(() => Response.json({ error: "Forbidden" }, { status: 403 }));
    mocks.getActivity.mockResolvedValue(empty);
  });

  it("authorizes a read inside the request scope and passes only server-derived owner/capability coordinates", async () => {
    const request = new Request("https://example.test/api/activity?actorId=someone-else&tenantId=other-tenant");
    const response = await route.GET(request);
    expect(mocks.enterRequestScope).toHaveBeenCalledExactlyOnceWith(request);
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "read", resourceType: "activity" });
    expect(mocks.canPerform).toHaveBeenCalledExactlyOnceWith("operator", "manage.workflow");
    expect(mocks.getActivity).toHaveBeenCalledExactlyOnceWith({
      tenantId: "tenant-a", actorId, role: "operator", canReadApprovals: true,
      requestActorBinding: {
        version: 1, kind: "auth_user", authUserId, canonicalActorId: `actor:${authUserId}`,
        legacyOwnerActorIds: [actorId], readableOwnerActorIds: [`actor:${authUserId}`, actorId],
      },
    }, { group: "all", limit: 25 });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(empty);
    expect(route).not.toHaveProperty("POST");
    expect(route).not.toHaveProperty("PATCH");
    expect(route).not.toHaveProperty("DELETE");
  });

  it("passes restricted approval coverage for a viewer regardless of query claims", async () => {
    mocks.authorizeRequest.mockResolvedValue({ ...context, role: "viewer" });
    const response = await route.GET(new Request("https://example.test/api/activity?canReadApprovals=true"));
    expect(response.status).toBe(200);
    expect(mocks.getActivity).toHaveBeenCalledWith(expect.objectContaining({ role: "viewer", canReadApprovals: false }), expect.anything());
  });

  it("does not read Activity when authorization fails and keeps the denial private", async () => {
    const denial = new Error("Forbidden");
    mocks.authorizeRequest.mockRejectedValue(denial);
    const response = await route.GET(new Request("https://example.test/api/activity"));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.forbiddenResponse).toHaveBeenCalledExactlyOnceWith(denial);
    expect(mocks.getActivity).not.toHaveBeenCalled();
  });

  it("rejects invalid pagination parameters after authorization without reading sources", async () => {
    const response = await route.GET(new Request("https://example.test/api/activity?limit=999"));
    expect(mocks.authorizeRequest).toHaveBeenCalledOnce();
    expect(mocks.getActivity).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ code: "activity_request_invalid", reload: true });
  });

  it("reauthorizes cursor requests and returns an explicit 409 reload contract", async () => {
    mocks.getActivity.mockRejectedValue(new ActivityRequestError("Activity changed or access was updated. Reload the first page.", 409, "activity_cursor_stale"));
    const request = new Request("https://example.test/api/activity?group=working&limit=10&cursor=fixture-cursor");
    const response = await route.GET(request);
    expect(mocks.authorizeRequest).toHaveBeenCalledExactlyOnceWith({ request, action: "read", resourceType: "activity" });
    expect(mocks.getActivity).toHaveBeenCalledWith(expect.anything(), { group: "working", limit: 10, cursor: "fixture-cursor" });
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Activity changed or access was updated. Reload the first page.", code: "activity_cursor_stale", reload: true });
  });

  it("reports unexpected service failure without serializing private exception details", async () => {
    mocks.getActivity.mockRejectedValue(new Error("PRIVATE_DATABASE_DETAIL"));
    const response = await route.GET(new Request("https://example.test/api/activity"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Activity could not be loaded.", code: "activity_unavailable" });
  });
});
