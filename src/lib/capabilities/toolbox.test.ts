import { describe, expect, it, vi } from "vitest";
import {
  AGENT_EXTERNAL_TOOL_ALLOWLIST_LIMIT,
  AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT,
  applyToolSchemaBudget,
  capabilityFunctionName,
  loadProgressiveAgentTools,
} from "@/lib/capabilities/toolbox";
import type { CapabilityDescriptor } from "@/lib/capabilities/types";
import type { ToolDefinition } from "@/lib/tools/types";

describe("progressive agent toolbox", () => {
  it("hydrates only the top six metadata matches by default", async () => {
    const descriptors = Array.from(
      { length: 20 },
      (_, index) => descriptor(`mcp:mail:tool-${index}`),
    );
    const search = vi.fn(async () => ({
      capabilities: descriptors,
      query: "mail",
      total: descriptors.length,
      limit: 24,
      hasMore: false,
    }));
    const resolveMcp = vi.fn(async (id: string) => tool({ id, category: "mcp" }));

    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-a", query: "mail" },
      {
        listNative: () => [tool({ id: "memory.search" })],
        search,
        resolveMcp,
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(resolveMcp).toHaveBeenCalledTimes(AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT);
    expect(result.definitions).toHaveLength(AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT + 1);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      query: "mail",
      sources: ["mcp", "openapi"],
    }));
  });

  it("reserves room for risk-zero resolvers from the action connector", async () => {
    const descriptors = [
      descriptor("mcp:github:actions_run_trigger", "mcp", 2),
      descriptor("mcp:github:create_issue", "mcp", 2),
      descriptor("mcp:github:update_file", "mcp", 2),
      descriptor("mcp:github:dispatch_deployment", "mcp", 2),
      descriptor("mcp:github:publish_release", "mcp", 2),
      descriptor("mcp:github:send_notification", "mcp", 2),
      descriptor("mcp:github:actions_list", "mcp", 0),
      descriptor("mcp:github:actions_get", "mcp", 0),
    ];
    const resolveMcp = vi.fn(async (id: string) => tool({
      id,
      category: "mcp",
      riskLevel: id.endsWith("_list") || id.endsWith("_get") ? 0 : 2,
      approvalRequired: id === "mcp:github:actions_run_trigger",
      approvalFingerprint: id === "mcp:github:actions_run_trigger"
        ? "reviewed-action-contract"
        : undefined,
    }));

    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-a", query: "run the github blog workflow" },
      {
        listNative: () => [],
        search: vi.fn(async () => ({
          capabilities: descriptors,
          query: "run the github blog workflow",
          total: descriptors.length,
          limit: 50,
          hasMore: false,
        })),
        resolveMcp,
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(result.definitions.map((item) => item.id)).toEqual([
      "mcp:github:actions_run_trigger",
      "mcp:github:create_issue",
      "mcp:github:update_file",
      "mcp:github:dispatch_deployment",
      "mcp:github:actions_list",
      "mcp:github:actions_get",
    ]);
    expect(result.definitions[0]).toMatchObject({
      approvalRequired: true,
      approvalFingerprint: "reviewed-action-contract",
    });
    expect(resolveMcp).toHaveBeenCalledTimes(AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT);
  });

  it("discovers missing resolvers with tenant-scoped same-connector metadata", async () => {
    const search = vi.fn(async (input: { query?: string }) => ({
      capabilities: input.query === "run portfolio blog automation"
        ? [descriptor("mcp:github:actions_run_trigger", "mcp", 2)]
        : [
            descriptor("mcp:github:actions_list", "mcp", 0),
            descriptor("mcp:github:actions_get", "mcp", 0),
            descriptor("mcp:slack:search_messages", "mcp", 0),
          ],
      query: input.query || "",
      total: 3,
      limit: 50,
      hasMore: false,
    }));

    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-private", query: "run portfolio blog automation" },
      {
        listNative: () => [],
        search,
        resolveMcp: vi.fn(async (id) => tool({
          id,
          category: "mcp",
          riskLevel: id.includes("run_trigger") ? 2 : 0,
        })),
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(result.definitions.map((item) => item.id)).toEqual([
      "mcp:github:actions_run_trigger",
      "mcp:github:actions_list",
      "mcp:github:actions_get",
    ]);
    expect(search).toHaveBeenNthCalledWith(2, expect.objectContaining({
      tenantId: "tenant-private",
      query: expect.stringMatching(/github.*search.*list.*get.*find.*lookup.*read/),
      sources: ["mcp"],
    }));
  });

  it("pins direct browser work to the least-privilege core from one connector", async () => {
    const descriptors = [
      descriptor("mcp:playwright:browser_click", "mcp", 2),
      descriptor("mcp:playwright:browser_close", "mcp", 2),
      descriptor("mcp:playwright:browser_drag", "mcp", 2),
      descriptor("mcp:playwright:browser_fill_form", "mcp", 2),
      descriptor("mcp:playwright:browser_find", "mcp", 0),
      descriptor("mcp:playwright:browser_navigate", "mcp", 1),
      descriptor("mcp:playwright:browser_snapshot", "mcp", 0),
    ];
    const resolveMcp = vi.fn(async (id: string) => tool({
      id,
      category: "mcp",
      riskLevel: id.endsWith("browser_navigate") ? 1 : 0,
    }));

    const result = await loadProgressiveAgentTools(
      {
        tenantId: "tenant-private",
        query: "Open https://example.com. Do not click, type, or submit anything.",
        requiredExternalOperationNames: [
          "browser_navigate",
          "browser_snapshot",
          "browser_find",
        ],
        excludedExternalOperationNames: [
          "browser_click",
          "browser_close",
          "browser_drag",
          "browser_fill_form",
        ],
      },
      {
        listNative: () => [],
        search: vi.fn(async () => ({
          capabilities: descriptors,
          query: "browser",
          total: descriptors.length,
          limit: 50,
          hasMore: false,
        })),
        resolveMcp,
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(result.definitions.map((item) => item.id)).toEqual([
      "mcp:playwright:browser_navigate",
      "mcp:playwright:browser_snapshot",
      "mcp:playwright:browser_find",
    ]);
  });

  it("keeps an explicitly requested browser click governed by its approval contract", async () => {
    const descriptors = [
      descriptor("mcp:other:browser_navigate", "mcp", 1),
      descriptor("mcp:playwright:browser_navigate", "mcp", 1),
      descriptor("mcp:playwright:browser_snapshot", "mcp", 0),
      descriptor("mcp:playwright:browser_find", "mcp", 0),
      descriptor("mcp:playwright:browser_click", "mcp", 2),
    ];

    const result = await loadProgressiveAgentTools(
      {
        tenantId: "tenant-private",
        query: "Open YouTube and play a video",
        requiredExternalOperationNames: [
          "browser_navigate",
          "browser_snapshot",
          "browser_find",
          "browser_click",
        ],
      },
      {
        listNative: () => [],
        search: vi.fn(async () => ({
          capabilities: descriptors,
          query: "browser",
          total: descriptors.length,
          limit: 50,
          hasMore: false,
        })),
        resolveMcp: vi.fn(async (id) => tool({
          id,
          category: "mcp",
          riskLevel: id.endsWith("browser_click") ? 2 : id.endsWith("browser_navigate") ? 1 : 0,
          approvalRequired: id.endsWith("browser_click"),
          approvalFingerprint: id.endsWith("browser_click")
            ? "reviewed-browser-click-contract"
            : undefined,
        })),
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(result.definitions.slice(0, 4).map((item) => item.id)).toEqual([
      "mcp:playwright:browser_navigate",
      "mcp:playwright:browser_snapshot",
      "mcp:playwright:browser_find",
      "mcp:playwright:browser_click",
    ]);
    expect(result.definitions[3]).toMatchObject({
      riskLevel: 2,
      approvalRequired: true,
      approvalFingerprint: "reviewed-browser-click-contract",
    });
  });

  it("hydrates no more than twelve exact allowlisted tools and skips other sources", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `openapi:mail:send-${index}`);
    const search = vi.fn(async (input: { query?: string }) => ({
      capabilities: input.query
        ? []
        : ids.map((id) => descriptor(id, "openapi")),
      query: input.query || "",
      total: input.query ? 0 : ids.length,
      limit: 48,
      hasMore: false,
    }));
    const resolveOpenApi = vi.fn(async (id: string) => tool({ id, category: "openapi" }));

    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-a", query: "ignored", preferredToolIds: ids },
      {
        listNative: () => [tool({ id: "memory.search" })],
        search,
        resolveMcp: vi.fn(async () => null),
        resolveOpenApi,
      },
    );

    expect(resolveOpenApi).toHaveBeenCalledTimes(AGENT_EXTERNAL_TOOL_ALLOWLIST_LIMIT);
    expect(result.definitions).toHaveLength(AGENT_EXTERNAL_TOOL_ALLOWLIST_LIMIT);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: undefined,
      allowlist: ids,
    }));
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("does not hydrate high-risk metadata and fails closed on resolver errors", async () => {
    const resolveMcp = vi.fn(async (id: string) => {
      if (id.endsWith("broken")) throw new Error("offline");
      return tool({ id, category: "mcp" });
    });
    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-a", query: "connector" },
      {
        listNative: () => [],
        search: vi.fn(async () => ({
          capabilities: [
            descriptor("mcp:connector:blocked", "mcp", 3),
            descriptor("mcp:connector:broken"),
            descriptor("mcp:connector:ready"),
          ],
          query: "connector",
          total: 3,
          limit: 24,
          hasMore: false,
        })),
        resolveMcp,
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(resolveMcp).toHaveBeenCalledTimes(2);
    expect(result.definitions.map((item) => item.id)).toEqual([
      "mcp:connector:ready",
    ]);
  });

  it("keeps one connector source available when the other catalog fails", async () => {
    const search = vi.fn(async (input: { sources?: readonly string[] }) => {
      if (input.sources?.length === 2 || input.sources?.[0] === "openapi") {
        throw new Error("OpenAPI catalog unavailable");
      }
      return {
        capabilities: [descriptor("mcp:connector:ready")],
        query: "connector",
        total: 1,
        limit: 24,
        hasMore: false,
      };
    });
    const result = await loadProgressiveAgentTools(
      { tenantId: "tenant-a", query: "connector" },
      {
        listNative: () => [],
        search,
        resolveMcp: vi.fn(async (id) => tool({ id, category: "mcp" })),
        resolveOpenApi: vi.fn(async () => null),
      },
    );

    expect(result.definitions.map((item) => item.id)).toEqual([
      "mcp:connector:ready",
    ]);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("enforces serialized per-tool and per-run schema byte budgets", () => {
    const result = applyToolSchemaBudget(
      [
        tool({ id: "small-a", inputSchema: { value: "1234" } }),
        tool({ id: "too-large", inputSchema: { value: "x".repeat(80) } }),
        tool({ id: "small-b", inputSchema: { value: "5678" } }),
      ],
      { perToolBytes: 40, perRunBytes: 20 },
    );

    expect(result.definitions.map((item) => item.id)).toEqual(["small-a"]);
    expect(result.omittedToolIds).toEqual(["too-large", "small-b"]);
    expect(result.schemaBytes).toBe(
      Buffer.byteLength(JSON.stringify({ value: "1234" }), "utf8"),
    );
  });

  it("creates deterministic collision-resistant model function names", () => {
    const first = capabilityFunctionName("mcp:mail/send:message");
    const same = capabilityFunctionName("mcp:mail/send:message");
    const formerlyColliding = capabilityFunctionName("mcp:mail_send:message");

    expect(first).toBe(same);
    expect(first).not.toBe(formerlyColliding);
    expect(first).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(first.length).toBeLessThanOrEqual(60);
  });
});

function descriptor(
  id: string,
  source: "mcp" | "openapi" = "mcp",
  riskLevel: 0 | 1 | 2 | 3 = 1,
): CapabilityDescriptor {
  return {
    id,
    name: id,
    description: "External operation.",
    category: source,
    source,
    riskLevel,
    approvalRequired: riskLevel >= 2,
    reversible: false,
  };
}

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: "memory.search",
    name: "Tool",
    description: "Tool description.",
    category: "memory",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    inputSchema: { type: "object" },
    ...overrides,
  };
}
