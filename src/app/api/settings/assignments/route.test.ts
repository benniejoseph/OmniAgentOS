import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  canonicalRequestActorBindingFromSecurityContext: vi.fn(),
  listModelAssignmentsForRequest: vi.fn(),
  saveModelAssignment: vi.fn(),
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
  listModelAssignmentsForRequest:
    routeMocks.listModelAssignmentsForRequest,
  saveModelAssignment: routeMocks.saveModelAssignment,
}));

import { GET, PUT } from "@/app/api/settings/assignments/route";

const context = {
  tenantId: "tenant-a",
  actorId: "assignment-owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "assignment-owner@example.test",
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
  routeMocks.listModelAssignmentsForRequest.mockReset().mockResolvedValue([]);
  routeMocks.saveModelAssignment.mockReset().mockResolvedValue({
    id: "22222222-2222-4222-8222-222222222222",
  });
});

describe("model assignment route ownership", () => {
  it("keeps bare GET exact-owner and publishes exact actionability", async () => {
    routeMocks.listModelAssignmentsForRequest.mockResolvedValue([
      { actorId: context.actorId, scope: "main_agent", manageable: true },
    ]);

    const response = await GET(new Request(
      "http://localhost/api/settings/assignments",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      assignments: [{ actorId: context.actorId, scope: "main_agent", manageable: true }],
      requestReadContracts: { modelAssignments: "exact_v1" },
    });
    expect(routeMocks.listModelAssignmentsForRequest).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });

  it("uses the authenticated request binding only for the readable opt-in", async () => {
    const response = await GET(new Request(
      "http://localhost/api/settings/assignments?ownerScope=readable",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      assignments: [],
      requestReadContracts: { modelAssignments: "readable_v1" },
    });
    expect(routeMocks.listModelAssignmentsForRequest).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
  });

  it("does not widen similar but unsupported owner scopes", async () => {
    const response = await GET(new Request(
      "http://localhost/api/settings/assignments?ownerScope=Readable",
    ));

    await expect(response.json()).resolves.toEqual({
      assignments: [],
      requestReadContracts: { modelAssignments: "exact_v1" },
    });
    expect(routeMocks.listModelAssignmentsForRequest).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
  });

  it("keeps PUT exact-owner without deriving a read binding", async () => {
    const response = await PUT(new Request(
      "http://localhost/api/settings/assignments?ownerScope=readable",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "main_agent",
          provider: "openai",
          modelId: "gpt-current",
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(routeMocks.saveModelAssignment).toHaveBeenCalledWith({
      ...context,
      scope: "main_agent",
      provider: "openai",
      modelId: "gpt-current",
    });
    expect(routeMocks.authorizeRequest).toHaveBeenCalledWith({
      request: expect.any(Request),
      action: "manage.connector",
      resourceType: "model_assignment",
      resourceId: "main_agent",
      metadata: {
        scope: "main_agent",
        provider: "openai",
        fallbackProvider: undefined,
        crossProviderFallbackConsent: false,
      },
    });
    expect(routeMocks.listModelAssignmentsForRequest).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });
});
