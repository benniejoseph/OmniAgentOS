import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getProviderConnection: vi.fn(),
  revokeProviderConnection: vi.fn(),
  updateProviderConnection: vi.fn(),
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

vi.mock("@/lib/settings/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/store")>()),
  getProviderConnection: routeMocks.getProviderConnection,
  revokeProviderConnection: routeMocks.revokeProviderConnection,
  updateProviderConnection: routeMocks.updateProviderConnection,
}));

vi.mock("@/lib/settings/provider-catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/provider-catalog")>()),
  validateAndRefreshProvider: routeMocks.validateAndRefreshProvider,
}));

import { DELETE, PATCH } from "@/app/api/settings/providers/[id]/route";
import { POST as VALIDATE } from "@/app/api/settings/providers/[id]/validate/route";

const context = {
  tenantId: "tenant-a",
  actorId: "provider-owner@example.test",
  role: "admin" as const,
  source: "session" as const,
};
const owner = { tenantId: context.tenantId, actorId: context.actorId };
const connection = {
  id: "provider-a",
  provider: "openai",
  label: "Personal OpenAI",
  status: "active",
  source: "tenant_vault",
  configuredFields: ["organization", "apiKey"],
  credentialVersion: 2,
};
const route = { params: Promise.resolve({ id: connection.id }) };

function providerRequest(
  method: string,
  options: { body?: unknown; key?: string | null; path?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.key !== null) headers["idempotency-key"] = options.key ?? `${method}-provider-1`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return new Request(
    `http://localhost/api/settings/providers/${connection.id}${options.path ?? ""}`,
    {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
  );
}

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.getProviderConnection.mockReset().mockResolvedValue(connection);
  routeMocks.revokeProviderConnection
    .mockReset()
    .mockResolvedValue({ ...connection, status: "revoked" });
  routeMocks.updateProviderConnection
    .mockReset()
    .mockResolvedValue({ ...connection, label: "Renamed" });
  routeMocks.validateAndRefreshProvider.mockReset().mockResolvedValue({
    connection,
    models: [{ modelId: "gpt-5" }],
  });
});

describe("provider connection routes", () => {
  it("updates the exact owner's connection through the settings service", async () => {
    const response = await PATCH(
      providerRequest("PATCH", { body: { label: "Renamed" } }),
      route,
    );

    expect(response.status).toBe(200);
    expect(routeMocks.updateProviderConnection).toHaveBeenCalledWith({
      ...owner,
      connectionId: connection.id,
      label: "Renamed",
    });
    await expect(response.json()).resolves.toMatchObject({
      connection: { id: connection.id, label: "Renamed" },
      serviceReceipt: { operation: "app.settings.providers.update" },
    });
  });

  it("validates the exact owner's connection through the settings service", async () => {
    const response = await VALIDATE(
      providerRequest("POST", { path: "/validate" }),
      route,
    );

    expect(response.status).toBe(200);
    expect(routeMocks.validateAndRefreshProvider).toHaveBeenCalledWith({
      ...owner,
      connectionId: connection.id,
    });
    await expect(response.json()).resolves.toMatchObject({
      connection: { id: connection.id },
      models: [{ modelId: "gpt-5" }],
      serviceReceipt: { operation: "app.settings.providers.validate" },
    });
  });

  it("revokes the exact vault connection it previewed", async () => {
    const response = await DELETE(providerRequest("DELETE"), route);

    expect(response.status).toBe(200);
    expect(routeMocks.getProviderConnection).toHaveBeenCalledWith({
      ...owner,
      connectionId: connection.id,
    });
    expect(routeMocks.revokeProviderConnection).toHaveBeenCalledTimes(1);
    expect(routeMocks.revokeProviderConnection).toHaveBeenCalledWith({
      ...owner,
      connectionId: connection.id,
    });
    await expect(response.json()).resolves.toMatchObject({
      connection: { id: connection.id, status: "revoked" },
      targetSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      serviceReceipt: {
        operation: "app.settings.providers.revoke",
        accessMode: "mutation",
        idempotencyKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("refuses every change without an Idempotency-Key before it is authorized", async () => {
    for (const response of [
      await PATCH(providerRequest("PATCH", { body: { enabled: false }, key: null }), route),
      await DELETE(providerRequest("DELETE", { key: null }), route),
      await VALIDATE(providerRequest("POST", { path: "/validate", key: null }), route),
    ]) {
      expect(response.status).toBe(400);
    }
    expect(routeMocks.authorizeRequest).not.toHaveBeenCalled();
    expect(routeMocks.updateProviderConnection).not.toHaveBeenCalled();
    expect(routeMocks.revokeProviderConnection).not.toHaveBeenCalled();
    expect(routeMocks.validateAndRefreshProvider).not.toHaveBeenCalled();
  });

  it("revokes nothing the owner's vault does not hold", async () => {
    for (const found of [undefined, { ...connection, source: "deployment" }]) {
      routeMocks.getProviderConnection.mockResolvedValue(found);

      const response = await DELETE(providerRequest("DELETE"), route);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: "SettingsStoreError",
        message: "Provider connection not found.",
      });
    }
    expect(routeMocks.revokeProviderConnection).not.toHaveBeenCalled();
  });

  it("touches no connection for an id the services would change", async () => {
    for (const id of [` ${connection.id}`, "p".repeat(201)]) {
      const target = { params: Promise.resolve({ id }) };
      for (const response of [
        await PATCH(providerRequest("PATCH", { body: { enabled: false } }), target),
        await DELETE(providerRequest("DELETE"), target),
        await VALIDATE(providerRequest("POST", { path: "/validate" }), target),
      ]) {
        expect(response.status, id).toBe(404);
      }
    }
    expect(routeMocks.getProviderConnection).not.toHaveBeenCalled();
    expect(routeMocks.updateProviderConnection).not.toHaveBeenCalled();
    expect(routeMocks.revokeProviderConnection).not.toHaveBeenCalled();
    expect(routeMocks.validateAndRefreshProvider).not.toHaveBeenCalled();
  });

  it("refuses to revoke a connection that changed after its preview", async () => {
    routeMocks.getProviderConnection
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce({ ...connection, credentialVersion: 3 });

    const response = await DELETE(providerRequest("DELETE"), route);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "AppServicePreviewMismatchError",
      message: "Provider revocation target changed after preview; review the exact target again.",
    });
    expect(routeMocks.revokeProviderConnection).not.toHaveBeenCalled();
  });
});
