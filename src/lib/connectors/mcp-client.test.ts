import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConnectorRecord } from "@/lib/connectors/types";

const networkMocks = vi.hoisted(() => ({
  assertPublicHttpUrl: vi.fn(),
  fetchPublicHttpUrl: vi.fn(),
}));
const credentialMocks = vi.hoisted(() => ({
  resolveMcpBearerCredential: vi.fn(),
}));

vi.mock("@/lib/security/network", () => networkMocks);
vi.mock("@/lib/connectors/credential-store", () => credentialMocks);

import {
  callMcpTool,
  discoverMcpTools,
} from "@/lib/connectors/mcp-client";

describe("MCP client", () => {
  beforeEach(() => {
    networkMocks.assertPublicHttpUrl.mockReset().mockResolvedValue(undefined);
    networkMocks.fetchPublicHttpUrl.mockReset();
    credentialMocks.resolveMcpBearerCredential
      .mockReset()
      .mockResolvedValue("generic-mcp-test-key");
  });

  it("discovers paginated tools from a generic Streamable HTTP server", async () => {
    networkMocks.fetchPublicHttpUrl.mockImplementation(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const method = init?.method || "GET";
      if (method === "GET") return new Response(null, { status: 405 });
      if (method === "DELETE") return new Response(null, { status: 204 });

      const message = parseMcpMessage(init);
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "initialize") {
        return initializationResponse(message.id);
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

  it("keeps generic and official GitHub MCP bearer authentication", async () => {
    let initializeHeaders: Headers | undefined;
    networkMocks.fetchPublicHttpUrl.mockImplementation(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const method = init?.method || "GET";
      if (method === "GET") return new Response(null, { status: 405 });
      if (method === "DELETE") return new Response(null, { status: 204 });
      const message = parseMcpMessage(init);
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "initialize") {
        initializeHeaders = new Headers(init?.headers);
        return initializationResponse(message.id);
      }
      if (message.method === "tools/list") {
        return sseResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [] },
        });
      }
      throw new Error(`Unexpected MCP method ${message.method || method}`);
    });

    await discoverMcpTools(connector({
      endpoint: "https://api.githubcopilot.com/mcp/x/all",
      authType: "bearer_vault",
      approvalRequired: false,
    }));

    expect(initializeHeaders?.get("authorization")).toBe("Bearer generic-mcp-test-key");
    expect(initializeHeaders?.has("x-browser-use-api-key")).toBe(false);
    expect(initializeHeaders?.has("x-omniagent-browser-scope")).toBe(false);
  });

  it.each([
    "https://asael.bennierichard.com/api/integrations/playwright/mcp",
    "https://asael.bennierichard.com/api/integrations/playwright/mcp?transport=sse",
    "https://omniagent-os-browser.fly.dev/mcp",
    "https://api.browser-use.com/v3/mcp",
    "https://api.browser-use.com/mcp",
  ])("rejects retired remote browser endpoint %s before network access", async (endpoint) => {
    await expect(discoverMcpTools(connector({ endpoint }))).rejects.toThrow(
      "Remote browser automation MCP is retired",
    );
    expect(networkMocks.assertPublicHttpUrl).not.toHaveBeenCalled();
    expect(networkMocks.fetchPublicHttpUrl).not.toHaveBeenCalled();
  });

  it("quarantines browser-control tools discovered through a generic MCP endpoint", async () => {
    networkMocks.fetchPublicHttpUrl.mockImplementation(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const method = init?.method || "GET";
      if (method === "GET") return new Response(null, { status: 405 });
      if (method === "DELETE") return new Response(null, { status: 204 });
      const message = parseMcpMessage(init);
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "initialize") {
        return initializationResponse(message.id);
      }
      if (message.method === "tools/list") {
        return sseResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [{
              name: "perform-action",
              title: "Web page control",
              description: "Click a DOM selector in the current tab.",
              inputSchema: {
                type: "object",
                properties: { selector: { type: "string" } },
              },
              annotations: { readOnlyHint: true },
            }],
          },
        });
      }
      throw new Error(`Unexpected MCP method ${message.method || method}`);
    });

    await expect(discoverMcpTools(connector())).rejects.toThrow(
      /Discovery quarantined tool "perform-action"/,
    );
  });

  it("rejects a previously stored browser-shaped tool before execution", async () => {
    await expect(callMcpTool({
      connector: connector(),
      toolName: "browser_navigate",
      args: { url: "https://example.com" },
    })).rejects.toThrow("Remote browser automation MCP is retired");
    expect(networkMocks.assertPublicHttpUrl).not.toHaveBeenCalled();
    expect(networkMocks.fetchPublicHttpUrl).not.toHaveBeenCalled();
  });

  it("rejects MCP tool results that carry the protocol error flag", async () => {
    networkMocks.fetchPublicHttpUrl.mockImplementation(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const method = init?.method || "GET";
      if (method === "GET") return new Response(null, { status: 405 });
      if (method === "DELETE") return new Response(null, { status: 204 });
      const message = parseMcpMessage(init);
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "initialize") {
        return initializationResponse(message.id);
      }
      if (message.method === "tools/call") {
        return sseResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            isError: true,
            content: [{ type: "text", text: "The document provider rejected this query." }],
          },
        });
      }
      throw new Error(`Unexpected MCP method ${message.method || method}`);
    });

    await expect(callMcpTool({
      connector: connector(),
      toolName: "query-docs",
      args: { query: "contracts" },
    })).rejects.toThrow(
      "MCP tool reported an error: The document provider rejected this query.",
    );
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

function parseMcpMessage(init?: RequestInit) {
  return JSON.parse(String(init?.body || "{}")) as {
    id?: string | number;
    method?: string;
    params?: { cursor?: string };
  };
}

function initializationResponse(id?: string | number) {
  return sseResponse({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "Mock MCP", version: "1.0.0" },
      instructions: "Use the mock tools for tests.",
    },
  });
}

function sseResponse(message: unknown, headers: Record<string, string> = {}) {
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function connector(
  overrides: Partial<McpConnectorRecord> = {},
): McpConnectorRecord {
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
    ...overrides,
  };
}
