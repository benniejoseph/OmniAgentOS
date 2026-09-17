import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discoverMcpTools: vi.fn(),
  getMcpConnector: vi.fn(),
  promoteMcpContracts: vi.fn(),
  recordMcpConnectorError: vi.fn(),
  saveMcpDiscovery: vi.fn(),
}));

vi.mock("@/lib/connectors/mcp-client", () => ({
  discoverMcpTools: mocks.discoverMcpTools,
}));
vi.mock("@/lib/connectors/store", () => ({
  getMcpConnector: mocks.getMcpConnector,
  promoteMcpContracts: mocks.promoteMcpContracts,
  recordMcpConnectorError: mocks.recordMcpConnectorError,
  saveMcpDiscovery: mocks.saveMcpDiscovery,
}));
vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/observability/store", () => ({
  createRequestTelemetry: vi.fn(() => ({
    correlationId: "connector-retirement-test",
  })),
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: vi.fn(async () => ({
    tenantId: "test-tenant",
    actorId: "test-admin",
    role: "admin",
  })),
  forbiddenResponse: vi.fn(() => Response.json({ error: "Forbidden" }, { status: 403 })),
}));

import { POST as discover } from "@/app/api/connectors/[id]/discover/route";
import { POST as review } from "@/app/api/connectors/[id]/review/route";

describe("retired browser connector discovery and review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMcpConnector.mockResolvedValue({
      id: "retired-browser",
      tenantId: "test-tenant",
      name: "Playwright Browser",
      endpoint: "https://mcp.example.test/mcp",
      transport: "streamable_http",
      authType: "none",
      status: "disabled",
      defaultRiskLevel: 2,
      approvalRequired: true,
      toolCount: 1,
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    });
  });

  it("returns gone before rediscovery can write contracts or errors", async () => {
    const response = await discover(
      new Request("http://localhost/api/connectors/retired-browser/discover", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "retired-browser" }) },
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      code: "isolated_browser_retired",
    });
    expect(mocks.discoverMcpTools).not.toHaveBeenCalled();
    expect(mocks.saveMcpDiscovery).not.toHaveBeenCalled();
    expect(mocks.recordMcpConnectorError).not.toHaveBeenCalled();
  });

  it("returns gone before contract promotion can reactivate the connector", async () => {
    const response = await review(
      new Request("http://localhost/api/connectors/retired-browser/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedFingerprint: "fingerprint-long-enough-for-review",
        }),
      }),
      { params: Promise.resolve({ id: "retired-browser" }) },
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      code: "isolated_browser_retired",
    });
    expect(mocks.promoteMcpContracts).not.toHaveBeenCalled();
  });
});
