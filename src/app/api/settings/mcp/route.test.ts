import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  class McpExportConfigurationReadConflictError extends Error {}
  return {
    McpExportConfigurationReadConflictError,
    authorizeRequest: vi.fn(),
    canonicalRequestActorBindingFromSecurityContext: vi.fn(),
    getMcpExportConfiguration: vi.fn(),
    getMcpExportConfigurationForRequest: vi.fn(),
    saveMcpExportConfiguration: vi.fn(),
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

vi.mock("@/lib/settings/http", () => ({
  settingsErrorResponse: routeMocks.settingsErrorResponse,
}));

vi.mock("@/lib/settings/store", () => ({
  getMcpExportConfiguration: routeMocks.getMcpExportConfiguration,
  getMcpExportConfigurationForRequest:
    routeMocks.getMcpExportConfigurationForRequest,
  McpExportConfigurationReadConflictError:
    routeMocks.McpExportConfigurationReadConflictError,
  saveMcpExportConfiguration: routeMocks.saveMcpExportConfiguration,
}));

import { GET, PUT } from "@/app/api/settings/mcp/route";

const context = {
  tenantId: "tenant-a",
  actorId: "mcp-owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "mcp-owner@example.test",
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
const exactConfiguration = {
  tenantId: context.tenantId,
  actorId: context.actorId,
  enabled: false,
  serverName: "Asael",
  allowedScopes: ["mcp:discover", "mcp:tools:list"],
  defaultApprovalMode: "governed",
  exposeResources: false,
  endpointPath: "/api/mcp",
  readiness: "disabled",
  createdAt: "2026-09-04T10:00:00.000Z",
  updatedAt: "2026-09-04T10:00:00.000Z",
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.canonicalRequestActorBindingFromSecurityContext
    .mockReset()
    .mockReturnValue(requestActorBinding);
  routeMocks.getMcpExportConfiguration
    .mockReset()
    .mockResolvedValue(exactConfiguration);
  routeMocks.getMcpExportConfigurationForRequest
    .mockReset()
    .mockResolvedValue({ ...exactConfiguration, manageable: true });
  routeMocks.saveMcpExportConfiguration
    .mockReset()
    .mockResolvedValue(exactConfiguration);
  routeMocks.settingsErrorResponse.mockReset().mockReturnValue(Response.json(
    { error: "Settings operation failed" },
    { status: 500, headers: { "cache-control": "no-store, private" } },
  ));
});

describe("MCP export configuration route ownership", () => {
  it("keeps bare GET exact-owner and publishes exact actionability", async () => {
    const response = await GET(new Request(
      "http://localhost/api/settings/mcp",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      mcp: { ...exactConfiguration, manageable: true },
      requestReadContracts: { mcpExportConfiguration: "exact_v1" },
    });
    expect(routeMocks.getMcpExportConfiguration).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    expect(
      routeMocks.getMcpExportConfigurationForRequest,
    ).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });

  it("uses the authenticated binding only for the literal readable GET opt-in", async () => {
    routeMocks.getMcpExportConfigurationForRequest.mockResolvedValue({
      ...exactConfiguration,
      enabled: true,
      serverName: "Retained MCP",
      readiness: "ready",
      manageable: false,
    });

    const response = await GET(new Request(
      "http://localhost/api/settings/mcp?ownerScope=readable",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      mcp: expect.objectContaining({
        actorId: context.actorId,
        serverName: "Retained MCP",
        manageable: false,
      }),
      requestReadContracts: { mcpExportConfiguration: "readable_v1" },
    });
    expect(routeMocks.getMcpExportConfigurationForRequest).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
    expect(routeMocks.getMcpExportConfiguration).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
  });

  it("does not widen a similar unsupported owner scope", async () => {
    const response = await GET(new Request(
      "http://localhost/api/settings/mcp?ownerScope=Readable",
    ));

    await expect(response.json()).resolves.toEqual({
      mcp: { ...exactConfiguration, manageable: true },
      requestReadContracts: { mcpExportConfiguration: "exact_v1" },
    });
    expect(routeMocks.getMcpExportConfiguration).toHaveBeenCalled();
    expect(
      routeMocks.getMcpExportConfigurationForRequest,
    ).not.toHaveBeenCalled();
  });

  it("keeps PUT exact-owner even when its URL carries the read opt-in", async () => {
    const response = await PUT(new Request(
      "http://localhost/api/settings/mcp?ownerScope=readable",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          serverName: "Current MCP",
          allowedScopes: ["mcp:discover", "mcp:tools:list"],
          exposeResources: true,
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(routeMocks.saveMcpExportConfiguration).toHaveBeenCalledWith({
      ...context,
      enabled: true,
      serverName: "Current MCP",
      allowedScopes: ["mcp:discover", "mcp:tools:list"],
      exposeResources: true,
    });
    expect(routeMocks.getMcpExportConfiguration).not.toHaveBeenCalled();
    expect(
      routeMocks.getMcpExportConfigurationForRequest,
    ).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });

  it("returns a private conflict without exposing request-reader details", async () => {
    routeMocks.getMcpExportConfigurationForRequest.mockRejectedValue(
      new routeMocks.McpExportConfigurationReadConflictError(
        "sensitive collision detail",
      ),
    );

    const response = await GET(new Request(
      "http://localhost/api/settings/mcp?ownerScope=readable",
    ));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      error: "MCP export configuration metadata could not be resolved safely.",
    });
    expect(routeMocks.settingsErrorResponse).not.toHaveBeenCalled();
  });

  it("logs only the error class for an unexpected readable dependency failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    routeMocks.getMcpExportConfigurationForRequest.mockRejectedValue(
      new Error("sensitive database detail"),
    );

    const response = await GET(new Request(
      "http://localhost/api/settings/mcp?ownerScope=readable",
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({
      error: "MCP export configuration is temporarily unavailable.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "MCP export configuration metadata read failed.",
      "Error",
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "sensitive database detail",
    );
    consoleError.mockRestore();
  });

  it("preserves the established settings error response for bare GET failures", async () => {
    const failure = new Error("exact read failed");
    routeMocks.getMcpExportConfiguration.mockRejectedValue(failure);

    const response = await GET(new Request(
      "http://localhost/api/settings/mcp",
    ));

    expect(response.status).toBe(500);
    expect(routeMocks.settingsErrorResponse).toHaveBeenCalledWith(failure);
  });
});
