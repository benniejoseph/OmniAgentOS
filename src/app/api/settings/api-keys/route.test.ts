import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  canonicalRequestActorBindingFromSecurityContext: vi.fn(),
  createServiceApiKey: vi.fn(),
  listServiceApiKeysForRequest: vi.fn(),
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

vi.mock("@/lib/settings/service-api-keys", () => ({
  ServiceApiKeyError: class ServiceApiKeyError extends Error {
    readonly status = 400;
  },
  createServiceApiKey: routeMocks.createServiceApiKey,
  listServiceApiKeysForRequest: routeMocks.listServiceApiKeysForRequest,
}));

import { GET, POST } from "@/app/api/settings/api-keys/route";

const context = {
  tenantId: "tenant-a",
  actorId: "settings-owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "settings-owner@example.test",
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
  routeMocks.listServiceApiKeysForRequest.mockReset().mockResolvedValue([]);
  routeMocks.createServiceApiKey.mockReset().mockResolvedValue({
    record: { id: "key-a" },
    token: "one-time-token",
  });
});

describe("service API key routes", () => {
  it("passes the canonical request binding only to GET listing", async () => {
    const response = await GET(
      new Request("http://localhost/api/settings/api-keys"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(routeMocks.listServiceApiKeysForRequest).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
  });

  it("keeps POST creation exact-owner without deriving a read binding", async () => {
    const response = await POST(new Request(
      "http://localhost/api/settings/api-keys",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Automation",
          scopes: ["mcp:discover"],
        }),
      },
    ));

    expect(response.status).toBe(201);
    expect(routeMocks.createServiceApiKey).toHaveBeenCalledWith({
      ...context,
      name: "Automation",
      scopes: ["mcp:discover"],
    });
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });

  it("rejects unsafe key names before authorization or persistence", async () => {
    const response = await POST(new Request(
      "http://localhost/api/settings/api-keys",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Automation\nkey",
          scopes: ["mcp:discover"],
        }),
      },
    ));

    expect(response.status).toBe(400);
    expect(routeMocks.authorizeRequest).not.toHaveBeenCalled();
    expect(routeMocks.createServiceApiKey).not.toHaveBeenCalled();
  });
});
