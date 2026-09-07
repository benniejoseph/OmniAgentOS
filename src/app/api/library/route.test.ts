import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  listWorkspaceLibrary: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn(),
}));

vi.mock("@/lib/library/store", () => ({
  listWorkspaceLibrary: mocks.listWorkspaceLibrary,
}));

import { GET } from "@/app/api/library/route";

const authUserId = "11111111-1111-4111-8111-111111111111";
const context = {
  tenantId: "tenant-1",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: authUserId,
    email: "owner@example.test",
    sessionId: "session-1",
    tenantName: "Tenant One",
  },
};

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue(context);
  mocks.listWorkspaceLibrary.mockReset().mockResolvedValue({
    items: [],
    total: 0,
    totalIsLowerBound: false,
    nextOffset: null,
    countsByKind: {},
  });
});

describe("workspace library route", () => {
  it("binds search, kinds, project, and the readable actor identity", async () => {
    const response = await GET(new Request(
      "http://localhost/api/library?q=launch&kind=image,transcript&project=project-1&limit=25&offset=50",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).toHaveBeenCalledWith({
      request: expect.any(Request),
      action: "read",
      resourceType: "workspace_library",
    });
    expect(mocks.listWorkspaceLibrary).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      actorId: "owner@example.test",
      requestActorBinding: {
        version: 1,
        kind: "auth_user",
        authUserId,
        canonicalActorId: `actor:${authUserId}`,
        legacyOwnerActorIds: ["owner@example.test"],
        readableOwnerActorIds: [
          `actor:${authUserId}`,
          "owner@example.test",
        ],
      },
      query: "launch",
      kinds: ["image", "transcript"],
      projectId: "project-1",
      limit: 25,
      offset: 50,
    });
    await expect(response.json()).resolves.toMatchObject({
      items: [],
      total: 0,
      serviceReceipt: {
        operation: "app.library.list",
        accessMode: "read",
      },
    });
  });

  it("rejects unknown kinds and out-of-range limits", async () => {
    const unknownKind = await GET(new Request(
      "http://localhost/api/library?kind=credential",
    ));
    const invalidLimit = await GET(new Request(
      "http://localhost/api/library?limit=101",
    ));

    expect(unknownKind.status).toBe(400);
    expect(invalidLimit.status).toBe(400);
    expect(mocks.listWorkspaceLibrary).not.toHaveBeenCalled();
  });

  it("returns a generic private failure without exposing storage detail", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.listWorkspaceLibrary.mockRejectedValueOnce(
      new Error("sensitive database detail"),
    );

    const response = await GET(new Request("http://localhost/api/library"));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(payload).toEqual({ error: "The workspace library is temporarily unavailable." });
    expect(JSON.stringify(payload)).not.toContain("sensitive database detail");
    expect(consoleError).toHaveBeenCalledWith("Workspace library read failed.", "Error");
    consoleError.mockRestore();
  });
});
