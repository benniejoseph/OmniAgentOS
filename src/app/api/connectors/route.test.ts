import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConnectorRecord } from "@/lib/connectors/types";

const mocks = vi.hoisted(() => ({
  discoverMcpTools: vi.fn(),
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
  listMcpConnectors: vi.fn(async () => []),
  listMcpTools: vi.fn(async () => []),
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

import { POST } from "@/app/api/connectors/route";

describe("POST /api/connectors", () => {
  beforeEach(() => {
    const saved = connector();
    mocks.assertPublicHttpUrl.mockReset().mockResolvedValue(undefined);
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
});

function connector(): McpConnectorRecord {
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
  };
}
