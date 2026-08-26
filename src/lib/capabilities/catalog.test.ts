import { describe, expect, it, vi } from "vitest";
import {
  createCapabilityCatalog,
  normalizeCapabilityAllowlist,
  normalizeCapabilityLimit,
  normalizeCapabilityQuery,
  type CapabilityCatalogDependencies,
} from "@/lib/capabilities/catalog";
import {
  CAPABILITY_MAX_ALLOWLIST_ENTRIES,
  CAPABILITY_MAX_LIMIT,
  CAPABILITY_MAX_QUERY_LENGTH,
} from "@/lib/capabilities/types";
import type { ToolDefinition } from "@/lib/tools/types";

describe("capability catalog", () => {
  it("normalizes active tools into compact descriptors without schemas", async () => {
    const catalog = createCapabilityCatalog(dependencies({
      native: [tool({
        id: "web.search",
        name: "Live <Web> Search",
        description: "Search\ncurrent facts.",
        category: "web",
        inputSchema: { type: "object", properties: { secret: { type: "string" } } },
        approvalFingerprint: "private-contract-hash",
        reversible: true,
      })],
    }));

    const result = await catalog.search({ tenantId: "tenant-a" });

    expect(result.capabilities).toEqual([{
      id: "web.search",
      name: "Live Web Search",
      description: "Search current facts.",
      category: "web",
      source: "native",
      riskLevel: 0,
      approvalRequired: false,
      reversible: true,
    }]);
    expect(result.capabilities[0]).not.toHaveProperty("inputSchema");
    expect(result.capabilities[0]).not.toHaveProperty("approvalFingerprint");
  });

  it("keeps inactive native, MCP, and OpenAPI tools out of discovery", async () => {
    const catalog = createCapabilityCatalog(dependencies({
      native: [tool({ id: "native.planned", status: "planned" })],
      mcp: [tool({ id: "mcp:connector:pending", status: "planned", category: "mcp" })],
      openapi: [tool({ id: "openapi:connector:disabled", status: "planned", category: "openapi" })],
    }));

    const result = await catalog.search({ tenantId: "tenant-a" });

    expect(result.capabilities).toEqual([]);
  });

  it("ranks exact and name matches ahead of description-only matches", async () => {
    const catalog = createCapabilityCatalog(dependencies({
      native: [
        tool({ id: "memory.search", name: "Search Memory", description: "Find durable records." }),
        tool({ id: "memory.other", name: "Memory Notes", description: "Includes search guidance." }),
        tool({ id: "knowledge.search", name: "Search Knowledge", description: "Search stored sources." }),
      ],
    }));

    const result = await catalog.search({
      tenantId: "tenant-a",
      query: "memory.search",
    });

    expect(result.capabilities[0]?.id).toBe("memory.search");
  });

  it("does not turn punctuation-only searches into broad catalog results", async () => {
    const catalog = createCapabilityCatalog(dependencies({
      native: [tool({ id: "memory.search" })],
    }));

    const result = await catalog.search({ tenantId: "tenant-a", query: "!!!" });

    expect(result.capabilities).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("applies allowlists before returning results and skips irrelevant connector scans", async () => {
    const deps = dependencies({
      native: [tool({ id: "memory.search" }), tool({ id: "web.search" })],
      mcp: [tool({ id: "mcp:connector:read", category: "mcp" })],
      openapi: [tool({ id: "openapi:connector:list", category: "openapi" })],
    });
    const catalog = createCapabilityCatalog(deps);

    const result = await catalog.search({
      tenantId: "tenant-a",
      allowlist: ["web.search"],
    });

    expect(result.capabilities.map((item) => item.id)).toEqual(["web.search"]);
    expect(deps.listMcp).not.toHaveBeenCalled();
    expect(deps.listOpenApi).not.toHaveBeenCalled();
  });

  it("passes the authenticated tenant to connector loaders", async () => {
    const deps = dependencies({
      mcp: [tool({ id: "mcp:connector:read", category: "mcp" })],
      openapi: [tool({ id: "openapi:connector:list", category: "openapi" })],
    });
    const catalog = createCapabilityCatalog(deps);

    await catalog.search({ tenantId: "tenant-private" });

    expect(deps.listMcp).toHaveBeenCalledWith({ tenantId: "tenant-private" });
    expect(deps.listOpenApi).toHaveBeenCalledWith({ tenantId: "tenant-private" });
  });

  it("resolves one source only and fails closed for inactive or disallowed capabilities", async () => {
    const deps = dependencies({
      resolvedMcp: tool({ id: "mcp:connector:read", category: "mcp" }),
      resolvedOpenApi: tool({
        id: "openapi:connector:write",
        category: "openapi",
        status: "planned",
      }),
    });
    const catalog = createCapabilityCatalog(deps);

    await expect(catalog.resolve({
      tenantId: "tenant-a",
      id: "mcp:connector:read",
    })).resolves.toMatchObject({ id: "mcp:connector:read", source: "mcp" });
    await expect(catalog.resolve({
      tenantId: "tenant-a",
      id: "openapi:connector:write",
    })).resolves.toBeNull();
    await expect(catalog.resolve({
      tenantId: "tenant-a",
      id: "mcp:connector:read",
      allowlist: [],
    })).resolves.toBeNull();

    expect(deps.resolveMcp).toHaveBeenCalledTimes(1);
    expect(deps.resolveOpenApi).toHaveBeenCalledTimes(1);
    expect(deps.resolveNative).not.toHaveBeenCalled();
  });

  it("bounds query, limit, and allowlist inputs", () => {
    expect(normalizeCapabilityQuery(`  ${"q".repeat(300)}  `)).toHaveLength(
      CAPABILITY_MAX_QUERY_LENGTH,
    );
    expect(normalizeCapabilityLimit(10_000)).toBe(CAPABILITY_MAX_LIMIT);
    expect(normalizeCapabilityLimit(Number.NaN)).toBe(12);
    expect(normalizeCapabilityAllowlist(
      Array.from({ length: 300 }, (_, index) => `tool.${index}`),
    )?.size).toBe(CAPABILITY_MAX_ALLOWLIST_ENTRIES);
  });
});

function dependencies({
  native = [],
  mcp = [],
  openapi = [],
  resolvedNative = null,
  resolvedMcp = null,
  resolvedOpenApi = null,
}: {
  native?: ToolDefinition[];
  mcp?: ToolDefinition[];
  openapi?: ToolDefinition[];
  resolvedNative?: ToolDefinition | null;
  resolvedMcp?: ToolDefinition | null;
  resolvedOpenApi?: ToolDefinition | null;
} = {}): CapabilityCatalogDependencies {
  return {
    listNative: vi.fn(async () => native),
    listMcp: vi.fn(async () => mcp),
    listOpenApi: vi.fn(async () => openapi),
    resolveNative: vi.fn(async () => resolvedNative),
    resolveMcp: vi.fn(async () => resolvedMcp),
    resolveOpenApi: vi.fn(async () => resolvedOpenApi),
  };
}

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: "memory.search",
    name: "Search Memory",
    description: "Read durable memory.",
    category: "memory",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: false,
    inputSchema: { type: "object" },
    ...overrides,
  };
}
