import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPublicHttpUrl: vi.fn(),
  getMcpConnector: vi.fn(),
  storeMcpBearerCredential: vi.fn(),
}));

vi.mock("@/lib/connectors/contract-review", () => ({
  mcpContractReviewSummary: vi.fn(() => ({ pendingCount: 0, contracts: [] })),
}));
vi.mock("@/lib/connectors/credential-store", () => {
  class McpCredentialStoreError extends Error {
    readonly status = 400;
  }
  return {
    McpCredentialStoreError,
    removeMcpBearerCredential: vi.fn(),
    storeMcpBearerCredential: mocks.storeMcpBearerCredential,
  };
});
vi.mock("@/lib/connectors/mcp-client", () => ({
  discoverMcpTools: vi.fn(),
}));
vi.mock("@/lib/connectors/store", () => ({
  getMcpConnector: mocks.getMcpConnector,
  recordMcpConnectorError: vi.fn(),
  saveMcpDiscovery: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: vi.fn(async () => ({
    tenantId: "test-tenant",
    actorId: "test-admin",
    role: "admin",
  })),
  forbiddenResponse: vi.fn(() => Response.json({ error: "Forbidden" }, { status: 403 })),
}));
vi.mock("@/lib/security/network", () => ({
  assertPublicHttpUrl: mocks.assertPublicHttpUrl,
}));
vi.mock("@/lib/settings/credential-vault", () => {
  class CredentialVaultUnavailableError extends Error {
    readonly status = 503;
  }
  return { CredentialVaultUnavailableError };
});

import { POST } from "@/app/api/connectors/[id]/credential/route";

describe("POST /api/connectors/[id]/credential", () => {
  beforeEach(() => {
    mocks.assertPublicHttpUrl.mockReset().mockResolvedValue(undefined);
    mocks.getMcpConnector.mockReset().mockResolvedValue({
      id: "retired-browser",
      tenantId: "test-tenant",
      name: "Playwright Browser",
      endpoint: "https://mcp.example.test/mcp",
      transport: "streamable_http",
      authType: "none",
      status: "disabled",
      defaultRiskLevel: 2,
      approvalRequired: true,
      toolCount: 0,
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    });
    mocks.storeMcpBearerCredential.mockReset();
  });

  it("refuses to restore credentials on a retired browser connector", async () => {
    const response = await POST(
      new Request("http://localhost/api/connectors/retired-browser/credential", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bearerToken: "secret-token" }),
      }),
      { params: Promise.resolve({ id: "retired-browser" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid MCP endpoint",
      message: expect.stringMatching(/retired/i),
    });
    expect(mocks.assertPublicHttpUrl).not.toHaveBeenCalled();
    expect(mocks.storeMcpBearerCredential).not.toHaveBeenCalled();
  });
});
