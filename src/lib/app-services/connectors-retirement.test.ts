import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  McpConnectorRecord,
  McpToolRecord,
} from "@/lib/connectors/types";

const mocks = vi.hoisted(() => ({
  assertPublicHttpUrl: vi.fn(),
  discoverMcpTools: vi.fn(),
  getMcpConnector: vi.fn(),
  listMcpConnectors: vi.fn(),
  listMcpTools: vi.fn(),
  promoteMcpContracts: vi.fn(),
  saveMcpConnector: vi.fn(),
  saveMcpDiscovery: vi.fn(),
  updateMcpConnector: vi.fn(),
}));

vi.mock("@/lib/connectors/mcp-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectors/mcp-client")>()),
  discoverMcpTools: mocks.discoverMcpTools,
}));

vi.mock("@/lib/connectors/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectors/store")>()),
  getMcpConnector: mocks.getMcpConnector,
  listMcpConnectors: mocks.listMcpConnectors,
  listMcpTools: mocks.listMcpTools,
  promoteMcpContracts: mocks.promoteMcpContracts,
  saveMcpConnector: mocks.saveMcpConnector,
  saveMcpDiscovery: mocks.saveMcpDiscovery,
  updateMcpConnector: mocks.updateMcpConnector,
}));

vi.mock("@/lib/connectors/secret-binding", () => ({
  evaluateConnectorSecretBinding: vi.fn(() => ({ allowed: true })),
}));

vi.mock("@/lib/security/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/network")>()),
  assertPublicHttpUrl: mocks.assertPublicHttpUrl,
}));

import {
  listConnectorsService,
  refreshConnectorService,
  registerConnectorService,
  reviewConnectorService,
  showConnectorService,
  updateConnectorService,
} from "@/lib/app-services/connectors";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";

describe("connector application-service remote browser retirement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPublicHttpUrl.mockResolvedValue(undefined);
    mocks.listMcpConnectors.mockResolvedValue([]);
    mocks.listMcpTools.mockResolvedValue([]);
  });

  it("hides endpoint- and identity-matched browser connectors from list and show", async () => {
    const retired = [
      connector({
        id: "retired-asael",
        name: "Legacy automation",
        endpoint: "https://asael.bennierichard.com/api/integrations/playwright/mcp?transport=sse",
      }),
      connector({
        id: "retired-browser-use",
        name: "Legacy automation",
        endpoint: "https://api.browser-use.com/v3/mcp",
      }),
      connector({
        id: "retired-identity",
        name: "Playwright Browser",
        endpoint: "https://mcp.example.test/mcp",
      }),
    ];
    const supported = connector();
    const supportedTool = tool(supported);
    mocks.listMcpConnectors.mockResolvedValue([...retired, supported]);
    mocks.listMcpTools.mockImplementation(async (connectorId?: string) => {
      if (!connectorId) {
        return [
          ...retired.map((item) => tool(item, { id: `tool-${item.id}` })),
          supportedTool,
        ];
      }
      const selected = [...retired, supported].find((item) => item.id === connectorId);
      return selected ? [tool(selected, { id: `tool-${selected.id}` })] : [];
    });
    mocks.getMcpConnector.mockImplementation(async (connectorId: string) =>
      [...retired, supported].find((item) => item.id === connectorId) || null,
    );

    const listed = await listConnectorsService(caller("list"), {
      kind: "mcp",
      limit: 20,
    });

    expect(listed.data.connectors).toHaveLength(1);
    expect(listed.data.connectors[0]).toMatchObject({
      kind: "mcp",
      connector: { id: supported.id, name: supported.name },
    });
    expect(JSON.stringify(listed.data)).not.toContain("retired-");

    for (const item of retired) {
      const shown = await showConnectorService(caller(`show-${item.id}`), {
        kind: "mcp",
        connectorId: item.id,
      });
      expect(shown.data).toEqual({
        kind: "mcp",
        connector: null,
        operations: [],
      });
      expect(shown.receipt.resourceCount).toBe(0);
    }

    const shown = await showConnectorService(caller("show-supported"), {
      kind: "mcp",
      connectorId: supported.id,
    });
    expect(shown.data).toMatchObject({
      kind: "mcp",
      connector: { id: supported.id },
      operations: [{ connectorId: supported.id, name: supportedTool.name }],
    });
  });

  it.each([
    {
      name: "Legacy automation",
      endpoint: "https://asael.bennierichard.com/api/integrations/playwright/mcp",
    },
    {
      name: "Legacy automation",
      endpoint: "https://omniagent-os-browser.fly.dev/mcp",
    },
    {
      name: "Legacy automation",
      endpoint: "https://api.browser-use.com/v3/mcp",
    },
    {
      name: "Remote Browser",
      endpoint: "https://mcp.example.test/mcp",
    },
  ])("rejects retired registration for $endpoint before network or persistence", async ({
    name,
    endpoint,
  }) => {
    await expect(registerConnectorService(caller("register-retired"), {
      kind: "mcp",
      name,
      endpoint,
      authType: "none",
      defaultRiskLevel: 2,
      approvalRequired: true,
    })).rejects.toThrow(/remote browser automation MCP is retired/i);

    expect(mocks.assertPublicHttpUrl).not.toHaveBeenCalled();
    expect(mocks.saveMcpConnector).not.toHaveBeenCalled();
  });

  it("rejects retired update, refresh, and review before mutation or network work", async () => {
    const retired = connector({
      id: "retired-browser",
      name: "Playwright Browser",
      endpoint: "https://mcp.example.test/mcp",
    });
    mocks.getMcpConnector.mockResolvedValue(retired);

    await expect(updateConnectorService(caller("update"), {
      kind: "mcp",
      connectorId: retired.id,
      status: "disabled",
    })).rejects.toThrow(/remote browser automation MCP is retired/i);
    await expect(refreshConnectorService(caller("refresh"), {
      kind: "mcp",
      connectorId: retired.id,
    })).rejects.toThrow(/remote browser automation MCP is retired/i);
    await expect(reviewConnectorService(caller("review"), {
      kind: "mcp",
      connectorId: retired.id,
      expectedFingerprint: "a".repeat(64),
    })).rejects.toThrow(/remote browser automation MCP is retired/i);

    expect(mocks.assertPublicHttpUrl).not.toHaveBeenCalled();
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
    expect(mocks.updateMcpConnector).not.toHaveBeenCalled();
    expect(mocks.discoverMcpTools).not.toHaveBeenCalled();
    expect(mocks.saveMcpDiscovery).not.toHaveBeenCalled();
    expect(mocks.promoteMcpContracts).not.toHaveBeenCalled();
  });

  it("keeps a normal MCP visible and supports its governed mutation lifecycle", async () => {
    const supported = connector();
    const discoveredTool = tool(supported);
    mocks.listMcpConnectors.mockResolvedValue([supported]);
    mocks.listMcpTools.mockResolvedValue([discoveredTool]);
    mocks.getMcpConnector.mockResolvedValue(supported);
    mocks.saveMcpConnector.mockImplementation(async (record: McpConnectorRecord) => record);
    mocks.updateMcpConnector.mockResolvedValue({
      ...supported,
      name: "Knowledge MCP",
    });
    mocks.discoverMcpTools.mockResolvedValue({
      tools: [discoveredTool],
      capabilities: { tools: true },
      instructions: "Use the MCP for grounded documentation lookup.",
      serverVersion: { name: "Docs", version: "1.0.0" },
    });
    mocks.saveMcpDiscovery.mockResolvedValue({
      connector: supported,
      tools: [discoveredTool],
    });
    mocks.promoteMcpContracts.mockResolvedValue({
      connector: supported,
      tools: [discoveredTool],
      promoted: 1,
    });

    const listed = await listConnectorsService(caller("normal-list"), {
      kind: "mcp",
    });
    expect(listed.data.connectors).toEqual([
      expect.objectContaining({ connector: expect.objectContaining({ id: supported.id }) }),
    ]);

    await expect(registerConnectorService(caller("normal-register"), {
      kind: "mcp",
      name: "Knowledge MCP",
      endpoint: supported.endpoint,
      authType: "none",
      defaultRiskLevel: 2,
      approvalRequired: true,
    })).resolves.toMatchObject({
      data: { kind: "mcp", connector: { endpoint: supported.endpoint } },
    });
    await expect(updateConnectorService(caller("normal-update"), {
      kind: "mcp",
      connectorId: supported.id,
      name: "Knowledge MCP",
    })).resolves.toMatchObject({
      data: { connector: { name: "Knowledge MCP" } },
    });
    await expect(refreshConnectorService(caller("normal-refresh"), {
      kind: "mcp",
      connectorId: supported.id,
    })).resolves.toMatchObject({
      data: { connector: { id: supported.id }, operations: [{ id: discoveredTool.id }] },
    });
    await expect(reviewConnectorService(caller("normal-review"), {
      kind: "mcp",
      connectorId: supported.id,
      expectedFingerprint: "b".repeat(64),
    })).resolves.toMatchObject({
      data: { result: { promoted: 1 } },
    });

    expect(mocks.assertPublicHttpUrl).toHaveBeenCalledWith(
      supported.endpoint,
      "mcp connector URL",
    );
    expect(mocks.saveMcpConnector).toHaveBeenCalledOnce();
    expect(mocks.updateMcpConnector).toHaveBeenCalledOnce();
    expect(mocks.discoverMcpTools).toHaveBeenCalledOnce();
    expect(mocks.saveMcpDiscovery).toHaveBeenCalledOnce();
    expect(mocks.promoteMcpContracts).toHaveBeenCalledOnce();
  });
});

function connector(overrides: Partial<McpConnectorRecord> = {}): McpConnectorRecord {
  const now = "2026-09-17T12:00:00.000Z";
  return {
    id: "supported-mcp",
    tenantId: "tenant-a",
    name: "Knowledge MCP",
    endpoint: "https://mcp.example.test/mcp",
    transport: "streamable_http",
    authType: "none",
    status: "active",
    defaultRiskLevel: 2,
    approvalRequired: true,
    toolCount: 1,
    lastDiscoveredAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function tool(
  owner: McpConnectorRecord,
  overrides: Partial<McpToolRecord> = {},
): McpToolRecord {
  const now = "2026-09-17T12:00:00.000Z";
  return {
    id: `mcp:${owner.id}:lookup`,
    tenantId: owner.tenantId,
    connectorId: owner.id,
    connectorName: owner.name,
    name: "lookup",
    description: "Look up grounded documentation.",
    inputSchema: { type: "object" },
    riskLevel: 0,
    approvalRequired: false,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function caller(correlationId: string) {
  const context = {
    tenantId: "tenant-a",
    actorId: "actor-a",
    role: "admin" as const,
    source: "service" as const,
  };
  return createAppServiceCaller({
    context,
    executionScope: createExecutionScope({
      tenantId: context.tenantId,
      initiatingActorId: context.actorId,
      executingPrincipalType: "user",
      executingPrincipalId: context.actorId,
      correlationId,
      purpose: "Verify retired connector boundaries.",
    }),
    idempotencyKey: correlationId,
  });
}
