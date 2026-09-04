import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  canonicalRequestActorBindingFromSecurityContext: vi.fn(),
  listProviderConnections: vi.fn(),
  listProviderConnectionsForRequest: vi.fn(),
  normalizeProviderCredentials: vi.fn(),
  saveProviderConnection: vi.fn(),
  validateAndRefreshProvider: vi.fn(),
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

vi.mock("@/lib/settings/provider-catalog", () => ({
  normalizeProviderCredentials: routeMocks.normalizeProviderCredentials,
  validateAndRefreshProvider: routeMocks.validateAndRefreshProvider,
}));

vi.mock("@/lib/settings/store", () => ({
  listProviderConnections: routeMocks.listProviderConnections,
  listProviderConnectionsForRequest:
    routeMocks.listProviderConnectionsForRequest,
  saveProviderConnection: routeMocks.saveProviderConnection,
}));

import { GET, POST } from "@/app/api/settings/providers/route";

const context = {
  tenantId: "tenant-a",
  actorId: "provider-owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "provider-owner@example.test",
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
  routeMocks.listProviderConnections.mockReset().mockResolvedValue([]);
  routeMocks.listProviderConnectionsForRequest.mockReset().mockResolvedValue([]);
  routeMocks.normalizeProviderCredentials.mockReset().mockReturnValue({
    apiKey: "normalized-secret",
  });
  routeMocks.saveProviderConnection.mockReset().mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
  });
  routeMocks.validateAndRefreshProvider.mockReset();
});

describe("provider connection route", () => {
  it("keeps bare GET exact-owner", async () => {
    const response = await GET(new Request(
      "http://localhost/api/settings/providers",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      providers: [],
      requestReadContracts: { providerConnections: "exact_v1" },
    });
    expect(routeMocks.listProviderConnections).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      includeDeploymentFallback: true,
    });
    expect(routeMocks.listProviderConnectionsForRequest).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });

  it("uses the authenticated request binding only for the readable opt-in", async () => {
    const response = await GET(new Request(
      "http://localhost/api/settings/providers?ownerScope=readable",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      providers: [],
      requestReadContracts: { providerConnections: "readable_v1" },
    });
    expect(routeMocks.listProviderConnectionsForRequest).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
      includeDeploymentFallback: true,
    });
    expect(routeMocks.listProviderConnections).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
  });

  it("does not widen similar but unsupported owner scopes", async () => {
    await GET(new Request(
      "http://localhost/api/settings/providers?ownerScope=Readable",
    ));

    expect(routeMocks.listProviderConnections).toHaveBeenCalled();
    expect(routeMocks.listProviderConnectionsForRequest).not.toHaveBeenCalled();
  });

  it("keeps POST creation exact-owner without deriving a read binding", async () => {
    const response = await POST(new Request(
      "http://localhost/api/settings/providers?ownerScope=readable",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          label: "OpenAI",
          credentials: { apiKey: "a".repeat(24) },
          validateNow: false,
        }),
      },
    ));

    expect(response.status).toBe(201);
    expect(routeMocks.saveProviderConnection).toHaveBeenCalledWith({
      ...context,
      provider: "openai",
      label: "OpenAI",
      credentials: { apiKey: "normalized-secret" },
    });
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
    expect(routeMocks.validateAndRefreshProvider).not.toHaveBeenCalled();
  });
});
