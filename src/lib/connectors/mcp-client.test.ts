import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConnectorRecord } from "@/lib/connectors/types";

const networkMocks = vi.hoisted(() => ({
  assertPublicHttpUrl: vi.fn(),
  fetchPublicHttpUrl: vi.fn(),
}));

vi.mock("@/lib/security/network", () => networkMocks);

import { discoverMcpTools } from "@/lib/connectors/mcp-client";

describe("discoverMcpTools", () => {
  beforeEach(() => {
    networkMocks.assertPublicHttpUrl.mockReset().mockResolvedValue(undefined);
    networkMocks.fetchPublicHttpUrl.mockReset();
  });

  it("discovers paginated tools from Streamable HTTP SSE responses", async () => {
    networkMocks.fetchPublicHttpUrl.mockImplementation(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const method = init?.method || "GET";
      if (method === "GET") {
        return new Response(null, { status: 405 });
      }
      if (method === "DELETE") {
        return new Response(null, { status: 204 });
      }

      const message = JSON.parse(String(init?.body || "{}")) as {
        id?: string | number;
        method?: string;
        params?: { cursor?: string };
      };
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "initialize") {
        return sseResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "Mock MCP", version: "1.0.0" },
            instructions: "Use the mock tools for tests.",
          },
        });
      }
      if (message.method === "tools/list") {
        return sseResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: message.params?.cursor
            ? {
                tools: [{
                  name: "query-docs",
                  description: "Query documentation.",
                  inputSchema: { type: "object", properties: { query: { type: "string" } } },
                }],
              }
            : {
                tools: [{
                  name: "resolve-library-id",
                  description: "Resolve a library identifier.",
                  inputSchema: { type: "object", properties: { library: { type: "string" } } },
                }],
                nextCursor: "page-2",
              },
        });
      }
      throw new Error(`Unexpected MCP method ${message.method || method}`);
    });

    const discovery = await discoverMcpTools(connector());

    expect(discovery.tools.map((tool) => tool.name)).toEqual([
      "resolve-library-id",
      "query-docs",
    ]);
    expect(discovery.serverVersion).toMatchObject({ name: "Mock MCP", version: "1.0.0" });
    expect(discovery.instructions).toBe("Use the mock tools for tests.");
  });

  it("turns a generic fetch failure into an actionable connection error", async () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    networkMocks.fetchPublicHttpUrl.mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { cause }),
    );

    await expect(discoverMcpTools(connector())).rejects.toThrow(
      "MCP endpoint connection timed out.",
    );
  });
});

function sseResponse(message: unknown) {
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function connector(): McpConnectorRecord {
  const now = new Date().toISOString();
  return {
    id: "mock-connector",
    tenantId: "test-tenant",
    name: "Mock MCP",
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
