import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConnectorRecord } from "@/lib/connectors/types";

const mocks = vi.hoisted(() => ({
  getMcpConnector: vi.fn(),
  listMcpTools: vi.fn(),
  updateMcpConnector: vi.fn(),
  assertPublicHttpUrl: vi.fn(),
  recordRuntimeEventSafely: vi.fn(),
}));

vi.mock("@/lib/app-services/connectors", () => ({
  deleteConnectorService: vi.fn(),
  previewConnectorDeleteService: vi.fn(),
}));
vi.mock("@/lib/app-services/contracts", () => ({
  createRequestMutationAppServiceCaller: vi.fn(),
}));
vi.mock("@/lib/connectors/secret-binding", () => ({
  evaluateConnectorSecretBinding: vi.fn(() => ({ allowed: true })),
}));
vi.mock("@/lib/connectors/store", () => ({
  getMcpConnector: mocks.getMcpConnector,
  listMcpTools: mocks.listMcpTools,
  updateMcpConnector: mocks.updateMcpConnector,
}));
vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/observability/store", () => ({
  createRequestTelemetry: vi.fn(() => ({
    requestId: "request-test",
    correlationId: "correlation-test",
  })),
  recordRuntimeEventSafely: mocks.recordRuntimeEventSafely,
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

import { PATCH } from "@/app/api/connectors/[id]/route";

describe("PATCH /api/connectors/[id]", () => {
  beforeEach(() => {
    const existing = retiredConnector();
    mocks.getMcpConnector.mockReset().mockResolvedValue(existing);
    mocks.listMcpTools.mockReset().mockResolvedValue([]);
    mocks.updateMcpConnector.mockReset().mockResolvedValue({
      ...existing,
      status: "disabled",
    });
    mocks.assertPublicHttpUrl.mockReset().mockResolvedValue(undefined);
    mocks.recordRuntimeEventSafely.mockReset().mockResolvedValue(undefined);
  });

  it("rejects changing a connector to a retired endpoint before persistence", async () => {
    const response = await patch({
      endpoint: "https://api.browser-use.com/v3/mcp",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid MCP endpoint",
      message: expect.stringMatching(/retired/i),
    });
    expect(mocks.assertPublicHttpUrl).not.toHaveBeenCalled();
    expect(mocks.updateMcpConnector).not.toHaveBeenCalled();
  });

  it("refuses to reactivate an existing retired browser connector", async () => {
    const response = await patch({ status: "active" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid MCP endpoint",
      message: expect.stringMatching(/retired/i),
    });
    expect(mocks.updateMcpConnector).not.toHaveBeenCalled();
  });

  it("still allows an existing retired connector to be disabled", async () => {
    const response = await patch({ status: "disabled" });

    expect(response.status).toBe(200);
    expect(mocks.updateMcpConnector).toHaveBeenCalledWith(
      "retired-browser",
      expect.objectContaining({ status: "disabled" }),
      expect.any(Object),
    );
  });
});

function patch(body: Record<string, unknown>) {
  return PATCH(
    new Request("http://localhost/api/connectors/retired-browser", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "retired-browser" }) },
  );
}

function retiredConnector(): McpConnectorRecord {
  const now = new Date().toISOString();
  return {
    id: "retired-browser",
    tenantId: "test-tenant",
    name: "Playwright Browser",
    endpoint: "https://asael.bennierichard.com/api/integrations/playwright/mcp",
    transport: "streamable_http",
    authType: "none",
    status: "active",
    defaultRiskLevel: 1,
    approvalRequired: false,
    toolCount: 1,
    lastDiscoveredAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
