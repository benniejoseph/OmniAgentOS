import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  class OAuthGrantReadConflictError extends Error {}
  return {
    OAuthGrantReadConflictError,
    authorizeRequest: vi.fn(),
    canonicalRequestActorBindingFromSecurityContext: vi.fn(),
    listOAuthGrants: vi.fn(),
    listOAuthGrantsForRequest: vi.fn(),
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

vi.mock("@/lib/connectors/oauth-providers", () => ({
  oauthConfigured: vi.fn(() => true),
  oauthProviders: {
    google: {
      label: "Google",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    },
  },
}));

vi.mock("@/lib/connectors/oauth-store", () => ({
  OAuthGrantReadConflictError: routeMocks.OAuthGrantReadConflictError,
  listOAuthGrants: routeMocks.listOAuthGrants,
  listOAuthGrantsForRequest: routeMocks.listOAuthGrantsForRequest,
}));

import { GET } from "@/app/api/oauth/route";

const context = {
  tenantId: "tenant-a",
  actorId: "oauth-owner@example.test",
  role: "operator" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "oauth-owner@example.test",
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
  routeMocks.listOAuthGrants.mockReset().mockResolvedValue([]);
  routeMocks.listOAuthGrantsForRequest.mockReset().mockResolvedValue([]);
});

describe("OAuth connection metadata route", () => {
  it("keeps bare GET exact-owner and acknowledges the exact contract", async () => {
    const response = await GET(new Request("http://localhost/api/oauth"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      grants: [],
      requestReadContracts: { oauthGrants: "exact_v1" },
    }));
    expect(routeMocks.listOAuthGrants).toHaveBeenCalledWith(
      context.tenantId,
      context.actorId,
    );
    expect(routeMocks.listOAuthGrantsForRequest).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });

  it("uses the authenticated binding only for literal readable opt-in", async () => {
    const response = await GET(new Request(
      "http://localhost/api/oauth?ownerScope=readable",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      grants: [],
      requestReadContracts: { oauthGrants: "readable_v1" },
    }));
    expect(routeMocks.listOAuthGrantsForRequest).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
    expect(routeMocks.listOAuthGrants).not.toHaveBeenCalled();
  });

  it("does not widen a similar unsupported owner scope", async () => {
    await GET(new Request("http://localhost/api/oauth?ownerScope=Readable"));

    expect(routeMocks.listOAuthGrants).toHaveBeenCalled();
    expect(routeMocks.listOAuthGrantsForRequest).not.toHaveBeenCalled();
  });

  it("returns a private conflict without leaking store details", async () => {
    routeMocks.listOAuthGrantsForRequest.mockRejectedValue(
      new routeMocks.OAuthGrantReadConflictError("sensitive detail"),
    );

    const response = await GET(new Request(
      "http://localhost/api/oauth?ownerScope=readable",
    ));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "OAuth connection metadata could not be resolved safely.",
    });
  });

  it("logs only the error class and returns a private dependency failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    routeMocks.listOAuthGrantsForRequest.mockRejectedValue(
      new Error("sensitive database detail"),
    );

    const response = await GET(new Request(
      "http://localhost/api/oauth?ownerScope=readable",
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "OAuth connections are temporarily unavailable.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "OAuth connection metadata read failed.",
      "Error",
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "sensitive database detail",
    );
    consoleError.mockRestore();
  });
});
