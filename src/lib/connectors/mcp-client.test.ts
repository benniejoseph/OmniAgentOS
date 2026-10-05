import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpToolContractDriftError } from "@/lib/connectors/contract-review";
import { createMcpToolId, resetMcpToolPolicyForReview } from "@/lib/connectors/store";
import type { McpConnectorRecord, McpToolRecord } from "@/lib/connectors/types";
import { redactExactSecrets } from "@/lib/security/secret-redaction";

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

  it("resets old reviewed policy when official GitHub expands its toolsets", () => {
    const target = connector({ endpoint: "https://api.githubcopilot.com/mcp/x/all",
      status: "disabled", defaultRiskLevel: 2, approvalRequired: false });
    const old = { ...reviewedTool({ name: "get_file_contents", inputSchema: { type: "object" } }, target),
      riskLevel: 3 as const, approvalRequired: true, status: "active" as const };
    const discovered = { ...old, riskLevel: 0 as const, approvalRequired: false,
      createdAt: "2026-10-05T00:00:00.000Z" };
    const reset = resetMcpToolPolicyForReview({
      discovered: [discovered], existing: [old], connector: target,
    });
    expect(reset).toEqual([{ ...discovered, status: "pending_review",
      createdAt: old.createdAt }]);
  });

  it("fences delayed admission before any network request after an absolute native deadline", async () => {
    let finish!: () => void;
    networkMocks.assertPublicHttpUrl.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await expect(discoverMcpTools(connector({ status: "disabled" }), { deadlineAt: Date.now() + 20 })).rejects.toThrow("lifetime");
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(networkMocks.fetchPublicHttpUrl).not.toHaveBeenCalled();
    expect(credentialMocks.resolveMcpBearerCredential).not.toHaveBeenCalled();
  });
  it("fences delayed vault resolution and compares the exact selected credential before opening transport", async () => {
    let finish!: (value: string) => void;
    credentialMocks.resolveMcpBearerCredential.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const target = connector({ status: "disabled", authType: "bearer_vault", credentialConfigured: true, credentialOriginMatch: true });
    await expect(discoverMcpTools(target, { deadlineAt: Date.now() + 20 })).rejects.toThrow("lifetime");
    finish("fixture-only-late-value"); await Promise.resolve(); await Promise.resolve();
    expect(networkMocks.fetchPublicHttpUrl).not.toHaveBeenCalled();
    credentialMocks.resolveMcpBearerCredential.mockResolvedValue("fixture-only-selected-value");
    const verify = vi.fn(() => { throw new Error("Credential generation changed"); });
    await expect(discoverMcpTools(target, { deadlineAt: Date.now() + 500, verifyCredential: verify })).rejects.toThrow("generation changed");
    expect(verify).toHaveBeenCalledExactlyOnceWith(["fixture-only-selected-value"]);
    expect(networkMocks.fetchPublicHttpUrl).not.toHaveBeenCalled();
  });
  it("rejects an already expired native deadline before DNS or credential admission", async () => {
    await expect(discoverMcpTools(connector({ status: "disabled" }), { deadlineAt: Date.now() - 1 })).rejects.toThrow();
    expect(networkMocks.assertPublicHttpUrl).not.toHaveBeenCalled(); expect(networkMocks.fetchPublicHttpUrl).not.toHaveBeenCalled();
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
      reviewedTool: reviewedTool({ name: "browser_navigate", inputSchema: { type: "object" } }),
      args: { url: "https://example.com" },
    })).rejects.toThrow("Remote browser automation MCP is retired");
    expect(networkMocks.assertPublicHttpUrl).not.toHaveBeenCalled();
    expect(networkMocks.fetchPublicHttpUrl).not.toHaveBeenCalled();
  });

  it("omits image, audio, and binary resource bytes without breaking text or structured content", async () => {
    const imageBytes = Buffer.from("private-image-bytes").toString("base64");
    const audioBytes = Buffer.from("private-audio-bytes").toString("base64");
    const resourceBytes = Buffer.from("private-resource-bytes").toString("base64");
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
          result: { tools: [resolveLibrary, queryDocs] },
        });
      }
      if (message.method === "tools/call") {
        return sseResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [
              { type: "text", text: "Analysis complete." },
              { type: "image", mimeType: "image/png", data: imageBytes },
              { type: "audio", mimeType: "audio/mpeg", data: audioBytes },
              {
                type: "resource",
                resource: {
                  uri: "file:///private.bin",
                  mimeType: "application/octet-stream",
                  blob: resourceBytes,
                },
              },
              {
                type: "resource",
                resource: {
                  uri: "file:///notes.txt",
                  mimeType: "text/plain",
                  text: "Resource text remains available.",
                },
              },
            ],
            structuredContent: {
              status: "complete",
              citations: [{ id: "note-1" }],
            },
          },
        });
      }
      throw new Error(`Unexpected MCP method ${message.method || method}`);
    });

    const result = await callMcpTool({
      connector: connector(),
      reviewedTool: reviewedTool(queryDocs),
      args: { query: "contracts" },
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(imageBytes);
    expect(serialized).not.toContain(audioBytes);
    expect(serialized).not.toContain(resourceBytes);
    expect(result).toMatchObject({
      content: expect.arrayContaining([
        { type: "text", text: "Analysis complete." },
        expect.objectContaining({
          type: "resource",
          resource: expect.objectContaining({ text: "Resource text remains available." }),
        }),
        {
          type: "text",
          text: "[1 image, 1 audio, 1 binary resource MCP blocks were omitted.]",
        },
      ]),
      structuredContent: {
        status: "complete",
        citations: [{ id: "note-1" }],
      },
    });
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
      if (message.method === "tools/list") {
        return sseResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [queryDocs] },
        });
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
      reviewedTool: reviewedTool(queryDocs),
      args: { query: "contracts" },
    })).rejects.toThrow(
      "MCP tool reported an error: The document provider rejected this query.",
    );
  });

  it.each<[string, Tool]>([
    ["an argument", { ...queryDocs, inputSchema: { ...queryDocs.inputSchema, required: ["query"] } }],
    ["a behavior hint", { ...queryDocs, annotations: { readOnlyHint: false } }],
    ["its result", { ...queryDocs, outputSchema: { type: "object", properties: { answer: { type: "string" } } } }],
  ])("refuses a reviewed tool whose server changed %s since the review, before calling it", async (_change, listed) => {
    const methods: string[] = [];
    networkMocks.fetchPublicHttpUrl.mockImplementation(mcpServer([resolveLibrary, listed], methods));

    const refusal = await callMcpTool({
      connector: connector(),
      reviewedTool: reviewedTool(queryDocs),
      args: { query: "contracts" },
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(McpToolContractDriftError);
    expect(refusal).toMatchObject({
      message: expect.stringContaining('MCP tool "query-docs" changed on its server after it was reviewed'),
      liveTool: {
        id: reviewedTool(queryDocs).id,
        inputSchema: listed.inputSchema,
        annotations: listed.annotations,
        outputSchema: listed.outputSchema,
      },
    });
    expect(methods).toContain("tools/list");
    expect(methods).not.toContain("tools/call");
  });

  it("refuses a reviewed tool its server no longer lists, before calling it", async () => {
    const methods: string[] = [];
    networkMocks.fetchPublicHttpUrl.mockImplementation(mcpServer([resolveLibrary], methods));

    const refusal = await callMcpTool({
      connector: connector(),
      reviewedTool: reviewedTool(queryDocs),
      args: { query: "contracts" },
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(McpToolContractDriftError);
    expect(refusal).toMatchObject({
      message: expect.stringContaining('MCP tool "query-docs" is no longer offered by its server'),
      liveTool: undefined,
    });
    expect(methods).not.toContain("tools/call");
  });

  it("compares the listed tool with the connector's secret removed, as discovery stored it", async () => {
    const withSecret: Tool = {
      ...queryDocs,
      name: "lookup-key",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string", default: "generic-mcp-test-key" } },
      },
    };
    const methods: string[] = [];
    networkMocks.fetchPublicHttpUrl.mockImplementation(mcpServer([withSecret], methods));
    const bearer = connector({ authType: "bearer_vault" });

    await callMcpTool({
      connector: bearer,
      reviewedTool: reviewedTool(redactExactSecrets(withSecret, ["generic-mcp-test-key"]), bearer),
      args: { query: "contracts" },
    });

    expect(methods).toContain("tools/call");
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

const resolveLibrary: Tool = {
  name: "resolve-library-id",
  description: "Resolve a library identifier.",
  inputSchema: { type: "object", properties: { library: { type: "string" } } },
};

const queryDocs: Tool = {
  name: "query-docs",
  description: "Query documentation.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

function mcpServer(tools: Tool[], methods: string[]) {
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method || "GET";
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    const message = parseMcpMessage(init);
    methods.push(message.method || method);
    if (message.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (message.method === "initialize") {
      return initializationResponse(message.id);
    }
    if (message.method === "tools/list") {
      return sseResponse({ jsonrpc: "2.0", id: message.id, result: { tools } });
    }
    if (message.method === "tools/call") {
      const listed = tools.some((tool) => tool.name === message.params?.name);
      return sseResponse({
        jsonrpc: "2.0",
        id: message.id,
        result: listed
          ? { content: [{ type: "text", text: "Called." }] }
          : { isError: true, content: [{ type: "text", text: "Unknown tool." }] },
      });
    }
    throw new Error(`Unexpected MCP method ${message.method || method}`);
  };
}

/** The tool as discovery stored it for review. */
function reviewedTool(tool: Tool, target = connector()): McpToolRecord {
  return {
    id: createMcpToolId(target.id, tool.name),
    tenantId: target.tenantId,
    connectorId: target.id,
    connectorName: target.name,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    riskLevel: 2,
    approvalRequired: true,
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function parseMcpMessage(init?: RequestInit) {
  return JSON.parse(String(init?.body || "{}")) as {
    id?: string | number;
    method?: string;
    params?: { cursor?: string; name?: string };
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
