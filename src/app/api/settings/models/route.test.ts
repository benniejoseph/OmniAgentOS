import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  canonicalRequestActorBindingFromSecurityContext: vi.fn(),
  listModelCatalogForRequest: vi.fn(),
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

vi.mock("@/lib/settings/http", () => ({
  settingsErrorResponse: vi.fn(() => Response.json(
    { error: "Settings operation failed" },
    { status: 500, headers: { "cache-control": "no-store, private" } },
  )),
}));

vi.mock("@/lib/settings/store", () => ({
  listModelCatalogForRequest: routeMocks.listModelCatalogForRequest,
}));

import { GET } from "@/app/api/settings/models/route";

const context = {
  tenantId: "tenant-a",
  actorId: "catalog-owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "catalog-owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const requestActorBinding = {
  version: 1,
  kind: "auth_user",
  authUserId: context.auth.userId,
  canonicalActorId: `actor:${context.auth.userId}`,
  legacyOwnerActorIds: [context.actorId],
  readableOwnerActorIds: [
    `actor:${context.auth.userId}`,
    context.actorId,
  ],
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.canonicalRequestActorBindingFromSecurityContext
    .mockReset()
    .mockReturnValue(requestActorBinding);
  routeMocks.listModelCatalogForRequest.mockReset().mockResolvedValue([]);
});

describe("model catalog route", () => {
  it("passes the authenticated request binding to the metadata list", async () => {
    const response = await GET(new Request(
      "http://localhost/api/settings/models",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(routeMocks.listModelCatalogForRequest).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
  });
});
