import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  canonicalRequestActorBindingFromSecurityContext: vi.fn(),
  listServiceApiKeysForRequest: vi.fn(),
  revokeServiceApiKey: vi.fn(),
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

vi.mock("@/lib/settings/service-api-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/service-api-keys")>()),
  listServiceApiKeysForRequest: routeMocks.listServiceApiKeysForRequest,
  revokeServiceApiKey: routeMocks.revokeServiceApiKey,
}));

import { DELETE } from "@/app/api/settings/api-keys/[id]/route";

const context = {
  tenantId: "tenant-a",
  actorId: "key-owner@example.test",
  role: "admin" as const,
  source: "session" as const,
};
const requestActorBinding = { version: 1, kind: "auth_user" };
const apiKey = {
  id: "key-a",
  name: "Automation",
  tokenPrefix: "asael_live",
  tokenLastFour: "a1b2",
  scopes: ["mcp:tools:list", "mcp:discover"],
  status: "active",
  expiresAt: "2026-12-01T00:00:00.000Z",
  manageable: true,
};
const route = { params: Promise.resolve({ id: apiKey.id }) };

function revokeRequest(headers: Record<string, string> = { "idempotency-key": "revoke-key-1" }) {
  return new Request(`http://localhost/api/settings/api-keys/${apiKey.id}`, {
    method: "DELETE",
    headers,
  });
}

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.canonicalRequestActorBindingFromSecurityContext
    .mockReset()
    .mockReturnValue(requestActorBinding);
  routeMocks.listServiceApiKeysForRequest.mockReset().mockResolvedValue([apiKey]);
  routeMocks.revokeServiceApiKey
    .mockReset()
    .mockResolvedValue({ ...apiKey, status: "revoked" });
});

describe("service API key revocation route", () => {
  it("revokes the exact key it previewed through the settings service", async () => {
    const response = await DELETE(revokeRequest(), route);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(routeMocks.listServiceApiKeysForRequest).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
    expect(routeMocks.revokeServiceApiKey).toHaveBeenCalledTimes(1);
    expect(routeMocks.revokeServiceApiKey).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      keyId: apiKey.id,
    });
    const body = await response.json();
    expect(body).toMatchObject({
      apiKey: { id: apiKey.id, status: "revoked" },
      targetSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      serviceReceipt: {
        operation: "app.settings.api_keys.revoke",
        accessMode: "mutation",
        idempotencyKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("refuses a revocation without an Idempotency-Key before it is authorized", async () => {
    const response = await DELETE(revokeRequest({}), route);

    expect(response.status).toBe(400);
    expect(routeMocks.authorizeRequest).not.toHaveBeenCalled();
    expect(routeMocks.revokeServiceApiKey).not.toHaveBeenCalled();
  });

  it("revokes nothing for a key the owner cannot manage", async () => {
    for (const keys of [[], [{ ...apiKey, manageable: false }]]) {
      routeMocks.listServiceApiKeysForRequest.mockResolvedValue(keys);

      const response = await DELETE(revokeRequest(), route);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: "ServiceApiKeyError",
        message: "API key not found.",
      });
    }
    expect(routeMocks.revokeServiceApiKey).not.toHaveBeenCalled();
  });

  it("reads no key for an id the services would change", async () => {
    for (const id of [` ${apiKey.id}`, "k".repeat(201)]) {
      const response = await DELETE(revokeRequest(), { params: Promise.resolve({ id }) });

      expect(response.status, id).toBe(404);
    }
    expect(routeMocks.listServiceApiKeysForRequest).not.toHaveBeenCalled();
    expect(routeMocks.revokeServiceApiKey).not.toHaveBeenCalled();
  });

  it("refuses to revoke a key that changed after its preview", async () => {
    routeMocks.listServiceApiKeysForRequest
      .mockResolvedValueOnce([apiKey])
      .mockResolvedValueOnce([{ ...apiKey, scopes: ["mcp:discover"] }]);

    const response = await DELETE(revokeRequest(), route);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "AppServicePreviewMismatchError",
      message: "API-key revocation target changed after preview; review the exact target again.",
    });
    expect(routeMocks.revokeServiceApiKey).not.toHaveBeenCalled();
  });
});
