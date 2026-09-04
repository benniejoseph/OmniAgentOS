import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  class SettingsStoreError extends Error {
    constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
      super(message);
    }
  }
  class McpExportConfigurationReadConflictError extends SettingsStoreError {
    constructor(message: string) {
      super(message, 409);
    }
  }
  return {
    McpExportConfigurationReadConflictError,
    SettingsStoreError,
    authorizeRequest: vi.fn(),
    canonicalRequestActorBindingFromSecurityContext: vi.fn(),
    getSettingsSnapshot: vi.fn(),
    settingsErrorResponse: vi.fn(),
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

vi.mock("@/lib/settings/snapshot", () => ({
  getSettingsSnapshot: routeMocks.getSettingsSnapshot,
}));

vi.mock("@/lib/settings/http", () => ({
  settingsErrorResponse: routeMocks.settingsErrorResponse,
}));

vi.mock("@/lib/settings/store", () => ({
  McpExportConfigurationReadConflictError:
    routeMocks.McpExportConfigurationReadConflictError,
  SettingsStoreError: routeMocks.SettingsStoreError,
}));

import { GET } from "@/app/api/settings/route";

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
  routeMocks.getSettingsSnapshot.mockReset().mockResolvedValue({ apiKeys: [] });
  routeMocks.settingsErrorResponse.mockReset().mockReturnValue(Response.json(
    { error: "Settings operation failed" },
    { status: 500, headers: { "cache-control": "no-store, private" } },
  ));
});

describe("settings snapshot route", () => {
  it("keeps opt-in metadata exact for a bare request", async () => {
    routeMocks.getSettingsSnapshot.mockResolvedValue({
      requestReadContracts: {
        providerConnections: "exact_v1",
        modelAssignments: "exact_v1",
        mcpExportConfiguration: "exact_v1",
      },
    });
    const response = await GET(new Request("http://localhost/api/settings"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      requestReadContracts: {
        providerConnections: "exact_v1",
        modelAssignments: "exact_v1",
        mcpExportConfiguration: "exact_v1",
      },
    });
    expect(routeMocks.getSettingsSnapshot).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
  });

  it("opts supported metadata into readable request ownership explicitly", async () => {
    routeMocks.getSettingsSnapshot.mockResolvedValue({
      requestReadContracts: {
        providerConnections: "readable_v1",
        modelAssignments: "readable_v1",
        mcpExportConfiguration: "readable_v1",
      },
    });
    const response = await GET(new Request(
      "http://localhost/api/settings?ownerScope=readable",
    ));

    await expect(response.json()).resolves.toEqual({
      requestReadContracts: {
        providerConnections: "readable_v1",
        modelAssignments: "readable_v1",
        mcpExportConfiguration: "readable_v1",
      },
    });
    expect(routeMocks.getSettingsSnapshot).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
      providerOwnerScope: "readable",
      modelAssignmentOwnerScope: "readable",
      mcpOwnerScope: "readable",
    });
  });

  it("does not widen similar but unsupported owner scopes", async () => {
    await GET(new Request(
      "http://localhost/api/settings?ownerScope=Readable",
    ));

    expect(routeMocks.getSettingsSnapshot).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
  });

  it("returns a private conflict for ambiguous readable MCP metadata", async () => {
    routeMocks.getSettingsSnapshot.mockRejectedValue(
      new routeMocks.McpExportConfigurationReadConflictError("sensitive collision detail"),
    );

    const response = await GET(new Request(
      "http://localhost/api/settings?ownerScope=readable",
    ));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      error: "MCP export configuration metadata could not be resolved safely.",
    });
    expect(routeMocks.settingsErrorResponse).not.toHaveBeenCalled();
  });

  it("logs only the error class for an unexpected readable snapshot failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    routeMocks.getSettingsSnapshot.mockRejectedValue(
      new Error("sensitive database detail"),
    );

    const response = await GET(new Request(
      "http://localhost/api/settings?ownerScope=readable",
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      error: "Settings are temporarily unavailable.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Settings snapshot read failed.",
      "Error",
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "sensitive database detail",
    );
    consoleError.mockRestore();
  });

  it("preserves established handling for other typed readable settings errors", async () => {
    const failure = new routeMocks.SettingsStoreError(
      "model assignment ownership is ambiguous",
      409,
    );
    routeMocks.getSettingsSnapshot.mockRejectedValue(failure);
    routeMocks.settingsErrorResponse.mockReturnValue(Response.json(
      { error: "SettingsStoreError" },
      { status: 409, headers: { "cache-control": "no-store, private" } },
    ));

    const response = await GET(new Request(
      "http://localhost/api/settings?ownerScope=readable",
    ));

    expect(response.status).toBe(409);
    expect(routeMocks.settingsErrorResponse).toHaveBeenCalledWith(failure);
  });

  it("preserves the established settings error response for bare GET failures", async () => {
    const failure = new Error("exact read failed");
    routeMocks.getSettingsSnapshot.mockRejectedValue(failure);

    const response = await GET(new Request("http://localhost/api/settings"));

    expect(response.status).toBe(500);
    expect(routeMocks.settingsErrorResponse).toHaveBeenCalledWith(failure);
  });
});
