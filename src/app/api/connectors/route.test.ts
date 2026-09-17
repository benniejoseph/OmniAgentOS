import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConnectorRecord } from "@/lib/connectors/types";

const mocks = vi.hoisted(() => ({
  discoverMcpTools: vi.fn(),
  listMcpConnectors: vi.fn(),
  listMcpTools: vi.fn(),
  saveMcpConnector: vi.fn(),
  recordMcpConnectorError: vi.fn(),
  assertPublicHttpUrl: vi.fn(),
}));

vi.mock("@/lib/connectors/mcp-client", () => ({
  discoverMcpTools: mocks.discoverMcpTools,
}));
vi.mock("@/lib/connectors/contract-review", () => ({
  mcpContractReviewSummary: vi.fn(() => ({ pendingCount: 0, contracts: [] })),
}));
vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/connectors/store", () => ({
  createMcpConnectorRecord: vi.fn(() => connector()),
  listMcpConnectors: mocks.listMcpConnectors,
  listMcpTools: mocks.listMcpTools,
  recordMcpConnectorError: mocks.recordMcpConnectorError,
  saveMcpConnector: mocks.saveMcpConnector,
  saveMcpDiscovery: vi.fn(),
}));
vi.mock("@/lib/connectors/secret-binding", () => ({
  evaluateConnectorSecretBinding: vi.fn(() => ({ allowed: true })),
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

import { GET, POST } from "@/app/api/connectors/route";

describe("POST /api/connectors", () => {
  beforeEach(() => {
    const saved = connector();
    mocks.assertPublicHttpUrl.mockReset().mockResolvedValue(undefined);
    mocks.listMcpConnectors.mockReset().mockResolvedValue([]);
    mocks.listMcpTools.mockReset().mockResolvedValue([]);
    mocks.saveMcpConnector.mockReset().mockResolvedValue(saved);
    mocks.recordMcpConnectorError.mockReset().mockResolvedValue({
      ...saved,
      status: "error",
      lastError: "MCP endpoint connection timed out.",
    });
    mocks.discoverMcpTools.mockReset().mockRejectedValue(
      new Error("MCP endpoint connection timed out."),
    );
  });

  it("omits retired browser connectors and their tools from every list projection", async () => {
    const retired = connector({
      id: "retired-browser",
      name: "Playwright Browser",
      endpoint: "https://mcp.example.test/mcp",
      status: "disabled",
    });
    const supported = connector({ id: "supported" });
    mocks.listMcpConnectors.mockResolvedValue([retired, supported]);
    mocks.listMcpTools.mockResolvedValue([
      { id: "retired-tool", connectorId: retired.id, status: "disabled" },
      { id: "supported-tool", connectorId: supported.id, status: "active" },
    ]);

    const response = await GET(new Request("http://localhost/api/connectors"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.connectors).toEqual([
      expect.objectContaining({ id: "supported" }),
    ]);
    expect(body.tools).toEqual([
      expect.objectContaining({ id: "supported-tool" }),
    ]);
    expect(body.stats).toMatchObject({ total: 1, active: 1, toolCount: 1 });
    expect(JSON.stringify(body)).not.toContain("retired-browser");
    expect(JSON.stringify(body)).not.toContain("retired-tool");
  });

  it("returns an upstream failure status instead of reporting a completed action", async () => {
    const response = await POST(new Request("http://localhost/api/connectors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Public MCP",
        endpoint: "https://mcp.example.test/mcp",
        discover: true,
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      discoveryFailed: true,
      error: "MCP endpoint connection timed out.",
      connector: { status: "error" },
      tools: [],
    });
  });

  it.each([
    "https://asael.bennierichard.com/api/integrations/playwright/mcp",
    "https://asael.bennierichard.com/api/integrations/playwright/mcp?transport=sse",
    "https://omniagent-os-browser.fly.dev/mcp",
    "https://api.browser-use.com/v3/mcp",
  ])("rejects retired remote browser endpoint %s before registration", async (endpoint) => {
    const response = await POST(new Request("http://localhost/api/connectors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Remote browser",
        endpoint,
        discover: false,
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid MCP endpoint",
      message: expect.stringMatching(/retired/i),
    });
    expect(mocks.assertPublicHttpUrl).not.toHaveBeenCalled();
    expect(mocks.saveMcpConnector).not.toHaveBeenCalled();
  });
});

function connector(overrides: Partial<McpConnectorRecord> = {}): McpConnectorRecord {
  const now = new Date().toISOString();
  return {
    id: "connector-1",
    tenantId: "test-tenant",
    name: "Public MCP",
    endpoint: "https://mcp.example.test/mcp",
    transport: "streamable_http",
    authType: "none",
    status: "active",
    defaultRiskLevel: 2,
    approvalRequired: true,
    toolCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
