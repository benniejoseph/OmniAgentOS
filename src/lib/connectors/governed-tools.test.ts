import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  OpenApiConnectorRecord,
  OpenApiOperationRecord,
} from "@/lib/connectors/openapi-types";
import type {
  McpConnectorRecord,
  McpToolRecord,
} from "@/lib/connectors/types";

const mocks = vi.hoisted(() => ({
  getMcpConnector: vi.fn(),
  getMcpToolById: vi.fn(),
  listMcpConnectors: vi.fn(),
  listMcpTools: vi.fn(),
  searchActiveMcpToolMetadata: vi.fn(),
  getOpenApiConnector: vi.fn(),
  getOpenApiOperationById: vi.fn(),
  listOpenApiConnectors: vi.fn(),
  listOpenApiOperations: vi.fn(),
  searchActiveOpenApiOperationMetadata: vi.fn(),
}));

vi.mock("@/lib/connectors/store", () => ({
  getMcpConnector: mocks.getMcpConnector,
  getMcpToolById: mocks.getMcpToolById,
  listMcpConnectors: mocks.listMcpConnectors,
  listMcpTools: mocks.listMcpTools,
  searchActiveMcpToolMetadata: mocks.searchActiveMcpToolMetadata,
}));

vi.mock("@/lib/connectors/openapi-store", () => ({
  getOpenApiConnector: mocks.getOpenApiConnector,
  getOpenApiOperationById: mocks.getOpenApiOperationById,
  listOpenApiConnectors: mocks.listOpenApiConnectors,
  listOpenApiOperations: mocks.listOpenApiOperations,
  searchActiveOpenApiOperationMetadata:
    mocks.searchActiveOpenApiOperationMetadata,
}));

import {
  getMcpGovernedTool,
  getOpenApiGovernedTool,
  listMcpGovernedTools,
  listOpenApiGovernedTools,
  openApiOperationToGovernedTool,
  searchMcpGovernedToolMetadata,
  searchOpenApiGovernedToolMetadata,
  toGovernedTool,
} from "@/lib/connectors/governed-tools";

describe("retired remote-browser governed tool quarantine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reclassifies full MCP contracts before list, search, resolve, or hydration", async () => {
    const browserConnector = mcpConnector({
      id: "mcp-automation",
      name: "Workflow service",
      endpoint: "https://automation.example.test/mcp",
    });
    const browserTool = mcpTool({
      id: "mcp:mcp-automation:perform_action",
      connectorId: browserConnector.id,
      connectorName: browserConnector.name,
      name: "perform_action",
      description: "Perform the requested action.",
      inputSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector in the current browser tab.",
          },
          action: { type: "string", enum: ["click"] },
        },
      },
    });
    const docsConnector = mcpConnector({
      id: "mcp-docs",
      name: "Documentation",
      endpoint: "https://docs.example.test/mcp",
    });
    const docsTool = mcpTool({
      id: "mcp:mcp-docs:search",
      connectorId: docsConnector.id,
      connectorName: docsConnector.name,
      name: "search",
      description: "Search product documentation.",
    });

    mocks.listMcpTools.mockResolvedValue([browserTool, docsTool]);
    mocks.listMcpConnectors.mockResolvedValue([
      browserConnector,
      docsConnector,
    ]);
    mocks.searchActiveMcpToolMetadata.mockResolvedValue([
      {
        ...mcpMetadata(browserTool),
        description: "Click a CSS selector in the active browser tab.",
      },
      mcpMetadata(docsTool),
    ]);
    mocks.getMcpToolById.mockResolvedValue(browserTool);
    mocks.getMcpConnector.mockResolvedValue(browserConnector);

    await expect(listMcpGovernedTools()).resolves.toMatchObject([
      { id: docsTool.id, status: "active" },
    ]);
    mocks.listMcpTools.mockClear();
    mocks.listMcpConnectors.mockClear();
    await expect(searchMcpGovernedToolMetadata()).resolves.toMatchObject([
      { id: docsTool.id },
    ]);
    expect(mocks.listMcpTools).not.toHaveBeenCalled();
    expect(mocks.listMcpConnectors).not.toHaveBeenCalled();
    await expect(getMcpGovernedTool(browserTool.id)).resolves.toBeNull();
    expect(toGovernedTool(browserTool, browserConnector).status).toBe("planned");
  });

  it("quarantines browser-control OpenAPI contracts but keeps generic browser data APIs", async () => {
    const automationConnector = openApiConnector({
      id: "openapi-automation",
      name: "Workflow service",
      baseUrl: "https://automation.example.test",
    });
    const browserOperation = openApiOperation({
      id: "openapi:openapi-automation:performAction",
      connectorId: automationConnector.id,
      connectorName: automationConnector.name,
      operationId: "performAction",
      path: "/actions",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "CSS selector in the active browser tab.",
          },
          action: { type: "string", enum: ["click"] },
        },
      },
    });
    const compatibilityConnector = openApiConnector({
      id: "openapi-compatibility",
      name: "Browser Compatibility API",
      baseUrl: "https://compatibility.example.test",
    });
    const compatibilityOperation = openApiOperation({
      id: "openapi:openapi-compatibility:list_browser_compatibility",
      connectorId: compatibilityConnector.id,
      connectorName: compatibilityConnector.name,
      operationId: "list_browser_compatibility",
      path: "/compatibility",
      summary: "Read supported browser compatibility metadata.",
    });

    mocks.listOpenApiOperations.mockResolvedValue([
      browserOperation,
      compatibilityOperation,
    ]);
    mocks.listOpenApiConnectors.mockResolvedValue([
      automationConnector,
      compatibilityConnector,
    ]);
    mocks.searchActiveOpenApiOperationMetadata.mockResolvedValue([
      {
        ...openApiMetadata(browserOperation),
        summary: "Click a CSS selector in the active browser tab.",
      },
      openApiMetadata(compatibilityOperation),
    ]);
    mocks.getOpenApiOperationById.mockResolvedValue(browserOperation);
    mocks.getOpenApiConnector.mockResolvedValue(automationConnector);

    await expect(listOpenApiGovernedTools()).resolves.toMatchObject([
      { id: compatibilityOperation.id, status: "active" },
    ]);
    mocks.listOpenApiOperations.mockClear();
    mocks.listOpenApiConnectors.mockClear();
    await expect(searchOpenApiGovernedToolMetadata()).resolves.toMatchObject([
      { id: compatibilityOperation.id },
    ]);
    expect(mocks.listOpenApiOperations).not.toHaveBeenCalled();
    expect(mocks.listOpenApiConnectors).not.toHaveBeenCalled();
    await expect(
      getOpenApiGovernedTool(browserOperation.id),
    ).resolves.toBeNull();
    expect(
      openApiOperationToGovernedTool(
        browserOperation,
        automationConnector,
      ).status,
    ).toBe("planned");
    expect(
      openApiOperationToGovernedTool(
        compatibilityOperation,
        compatibilityConnector,
      ).status,
    ).toBe("active");
  });

  it("quarantines dedicated remote-browser OpenAPI connector identities", async () => {
    const connector = openApiConnector({
      name: "Browser Use",
      baseUrl: "https://api.browser-use.com/v3",
    });
    const operation = openApiOperation({
      operationId: "run_session",
      summary: "Run a session.",
    });
    mocks.getOpenApiOperationById.mockResolvedValue(operation);
    mocks.getOpenApiConnector.mockResolvedValue(connector);

    await expect(getOpenApiGovernedTool(operation.id)).resolves.toBeNull();
  });
});

function mcpConnector(
  overrides: Partial<McpConnectorRecord> = {},
): McpConnectorRecord {
  return {
    id: "mcp-connector",
    tenantId: "tenant-a",
    name: "Connector",
    endpoint: "https://api.example.test/mcp",
    transport: "streamable_http",
    authType: "none",
    status: "active",
    defaultRiskLevel: 1,
    approvalRequired: false,
    toolCount: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function mcpTool(overrides: Partial<McpToolRecord> = {}): McpToolRecord {
  return {
    id: "mcp:mcp-connector:search",
    tenantId: "tenant-a",
    connectorId: "mcp-connector",
    connectorName: "Connector",
    name: "search",
    inputSchema: { type: "object" },
    riskLevel: 1,
    approvalRequired: false,
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function mcpMetadata(tool: McpToolRecord) {
  return {
    id: tool.id,
    connectorId: tool.connectorId,
    connectorName: tool.connectorName,
    name: tool.name,
    title: tool.title,
    description: tool.description,
    riskLevel: tool.riskLevel,
    approvalRequired: tool.approvalRequired,
    trustedGitHubEndpoint: false,
  };
}

function openApiConnector(
  overrides: Partial<OpenApiConnectorRecord> = {},
): OpenApiConnectorRecord {
  return {
    id: "openapi-connector",
    tenantId: "tenant-a",
    name: "OpenAPI",
    baseUrl: "https://api.example.test",
    authType: "none",
    status: "active",
    defaultRiskLevel: 1,
    approvalRequired: false,
    operationCount: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function openApiOperation(
  overrides: Partial<OpenApiOperationRecord> = {},
): OpenApiOperationRecord {
  return {
    id: "openapi:openapi-connector:list",
    tenantId: "tenant-a",
    connectorId: "openapi-connector",
    connectorName: "OpenAPI",
    operationId: "list",
    method: "GET",
    path: "/items",
    inputSchema: { type: "object" },
    responseContentTypes: ["application/json"],
    riskLevel: 1,
    approvalRequired: false,
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function openApiMetadata(operation: OpenApiOperationRecord) {
  return {
    id: operation.id,
    connectorId: operation.connectorId,
    connectorName: operation.connectorName,
    operationId: operation.operationId,
    method: operation.method,
    summary: operation.summary,
    description: operation.description,
    riskLevel: operation.riskLevel,
    approvalRequired: operation.approvalRequired,
  };
}
