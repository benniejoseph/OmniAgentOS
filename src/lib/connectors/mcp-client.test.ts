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

import { callMcpTool, discoverMcpTools } from "@/lib/connectors/mcp-client";

describe("discoverMcpTools", () => {
  beforeEach(() => {
    networkMocks.assertPublicHttpUrl.mockReset().mockResolvedValue(undefined);
    networkMocks.fetchPublicHttpUrl.mockReset();
    credentialMocks.resolveMcpBearerCredential
      .mockReset()
      .mockResolvedValue("browser-use-test-key");
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

  it("sends a vaulted Browser Use key in the provider-specific header", async () => {
    let initializeHeaders: Headers | undefined;
    networkMocks.fetchPublicHttpUrl.mockImplementation(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const method = init?.method || "GET";
      if (method === "GET") return new Response(null, { status: 405 });
      if (method === "DELETE") return new Response(null, { status: 204 });

      const message = JSON.parse(String(init?.body || "{}")) as {
        id?: string | number;
        method?: string;
      };
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "initialize") {
        initializeHeaders = new Headers(init?.headers);
        return sseResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "Browser Use", version: "1.0.0" },
          },
        });
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
      endpoint: "https://api.browser-use.com/v3/mcp",
      authType: "bearer_vault",
      approvalRequired: false,
    }));

    expect(initializeHeaders?.get("x-browser-use-api-key")).toBe(
      "browser-use-test-key",
    );
    expect(initializeHeaders?.has("authorization")).toBe(false);
  });

  it("authenticates Playwright and sends only an opaque tenant-actor-run scope", async () => {
    credentialMocks.resolveMcpBearerCredential.mockResolvedValue(
      "playwright-service-token-for-tests",
    );
    let initializeHeaders: Headers | undefined;
    networkMocks.fetchPublicHttpUrl.mockImplementation(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const method = init?.method || "GET";
      if (method === "GET") return new Response(null, { status: 405 });
      if (method === "DELETE") return new Response(null, { status: 204 });

      const message = JSON.parse(String(init?.body || "{}")) as {
        id?: string | number;
        method?: string;
      };
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "initialize") {
        initializeHeaders = new Headers(init?.headers);
        return sseResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "Playwright", version: "1.0.0" },
          },
        });
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
      endpoint: "https://omniagent-os-browser.fly.dev/mcp",
      authType: "bearer_vault",
      approvalRequired: false,
    }), { actorId: "actor-a" });

    expect(initializeHeaders?.get("authorization")).toBe(
      "Bearer playwright-service-token-for-tests",
    );
    const scope = initializeHeaders?.get("x-omniagent-browser-scope") || "";
    expect(scope).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(scope).not.toContain("actor-a");
    expect(scope).not.toContain("test-tenant");
  });

  it("reuses one Playwright client session within a governed run", async () => {
    credentialMocks.resolveMcpBearerCredential.mockResolvedValue(
      "playwright-service-token-for-tests",
    );
    let initializeCount = 0;
    let sessionMode: string | null = null;
    const toolCalls: string[] = [];
    networkMocks.fetchPublicHttpUrl.mockImplementation(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const method = init?.method || "GET";
      if (method === "GET") return new Response(null, { status: 405 });
      if (method === "DELETE") return new Response(null, { status: 204 });

      const message = JSON.parse(String(init?.body || "{}")) as {
        id?: string | number;
        method?: string;
        params?: { name?: string };
      };
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "initialize") {
        initializeCount += 1;
        sessionMode = new Headers(init?.headers).get("x-omniagent-browser-session");
        return sseResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "Playwright", version: "1.0.0" },
          },
        }, { "mcp-session-id": "browser-session-1" });
      }
      if (message.method === "tools/call") {
        toolCalls.push(message.params?.name || "unknown");
        return sseResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: "ok" }],
          },
        });
      }
      throw new Error(`Unexpected MCP method ${message.method || method}`);
    });

    const browserConnector = connector({
      id: "playwright-session-reuse",
      endpoint: "https://omniagent-os-browser.fly.dev/mcp",
      authType: "bearer_vault",
      approvalRequired: false,
    });
    const sessionScope = {
      tenantId: "test-tenant",
      actorId: "actor-a",
      executionId: "agent:run-session-reuse",
    };

    await callMcpTool({
      connector: browserConnector,
      toolName: "browser_navigate",
      args: { url: "https://example.com" },
      sessionScope,
    });
    await callMcpTool({
      connector: browserConnector,
      toolName: "browser_snapshot",
      args: {},
      sessionScope,
    });

    expect(initializeCount).toBe(1);
    expect(sessionMode).toBe("run");
    expect(toolCalls).toEqual(["browser_navigate", "browser_snapshot"]);
  });

  it("rejects MCP tool results that carry the protocol error flag", async () => {
    networkMocks.fetchPublicHttpUrl.mockImplementation(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const method = init?.method || "GET";
      if (method === "GET") return new Response(null, { status: 405 });
      if (method === "DELETE") return new Response(null, { status: 204 });

      const message = JSON.parse(String(init?.body || "{}")) as {
        id?: string | number;
        method?: string;
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
          },
        });
      }
      if (message.method === "tools/call") {
        return sseResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            isError: true,
            content: [{
              type: "text",
              text: "net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/private?token=hidden",
            }],
          },
        });
      }
      throw new Error(`Unexpected MCP method ${message.method || method}`);
    });

    await expect(callMcpTool({
      connector: connector(),
      toolName: "browser_navigate",
      args: { url: "https://example.com" },
    })).rejects.toThrow(
      "The browser network gateway could not establish a secure connection to the destination.",
    );
  });
});

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
