import {
  getMcpGovernedTool,
  getOpenApiGovernedTool,
  searchMcpGovernedToolMetadata,
  searchOpenApiGovernedToolMetadata,
} from "@/lib/connectors/governed-tools";
import { getGovernedTool, getGovernedTools } from "@/lib/tools/registry";
import type { ToolDefinition } from "@/lib/tools/types";
import {
  CAPABILITY_DEFAULT_LIMIT,
  CAPABILITY_MAX_ALLOWLIST_ENTRIES,
  CAPABILITY_MAX_LIMIT,
  CAPABILITY_MAX_METADATA_CANDIDATES,
  CAPABILITY_MAX_QUERY_LENGTH,
  type CapabilityDescriptor,
  type CapabilityResolveInput,
  type CapabilitySearchInput,
  type CapabilitySearchResult,
  type CapabilitySource,
} from "@/lib/capabilities/types";

type CapabilityListOptions = {
  tenantId: string;
  query?: string;
  limit: number;
  allowlist?: readonly string[];
};

type CapabilityCatalogItem = ToolDefinition | CapabilityDescriptor;

export type CapabilityCatalogDependencies = {
  listNative: (options: CapabilityListOptions) => readonly CapabilityCatalogItem[] | Promise<readonly CapabilityCatalogItem[]>;
  listMcp: (options: CapabilityListOptions) => Promise<readonly CapabilityCatalogItem[]>;
  listOpenApi: (options: CapabilityListOptions) => Promise<readonly CapabilityCatalogItem[]>;
  resolveNative: (id: string) => ToolDefinition | null | undefined | Promise<ToolDefinition | null | undefined>;
  resolveMcp: (id: string, options: { tenantId: string }) => Promise<ToolDefinition | null>;
  resolveOpenApi: (id: string, options: { tenantId: string }) => Promise<ToolDefinition | null>;
};

export type CapabilityCatalog = {
  search: (input: CapabilitySearchInput) => Promise<CapabilitySearchResult>;
  resolve: (input: CapabilityResolveInput) => Promise<CapabilityDescriptor | null>;
};

const defaultDependencies: CapabilityCatalogDependencies = {
  listNative: getGovernedTools,
  listMcp: (options) => searchMcpGovernedToolMetadata(options),
  listOpenApi: (options) => searchOpenApiGovernedToolMetadata(options),
  resolveNative: getGovernedTool,
  resolveMcp: (id, options) => getMcpGovernedTool(id, options),
  resolveOpenApi: (id, options) => getOpenApiGovernedTool(id, options),
};

export function createCapabilityCatalog(
  dependencies: CapabilityCatalogDependencies = defaultDependencies,
): CapabilityCatalog {
  return {
    async search(input) {
      const query = normalizeCapabilityQuery(input.query);
      const limit = normalizeCapabilityLimit(input.limit);
      const allowlist = normalizeCapabilityAllowlist(input.allowlist);
      const requestedSources = sourcesForSearch(allowlist, input.sources);
      const metadataLimit = Math.min(
        CAPABILITY_MAX_METADATA_CANDIDATES,
        Math.max(limit * 4, allowlist?.size || 0, limit),
      );
      const listOptions: CapabilityListOptions = {
        tenantId: input.tenantId,
        query: query || undefined,
        limit: metadataLimit,
        allowlist: allowlist ? [...allowlist] : undefined,
      };

      const [native, mcp, openapi] = await Promise.all([
        requestedSources.has("native")
          ? dependencies.listNative(listOptions)
          : Promise.resolve([]),
        requestedSources.has("mcp")
          ? dependencies.listMcp(listOptions)
          : Promise.resolve([]),
        requestedSources.has("openapi")
          ? dependencies.listOpenApi(listOptions)
          : Promise.resolve([]),
      ]);

      const capabilities = deduplicateCapabilities([
        ...normalizeActiveTools(native, "native"),
        ...normalizeActiveTools(mcp, "mcp"),
        ...normalizeActiveTools(openapi, "openapi"),
      ])
        .filter((capability) => !allowlist || allowlist.has(capability.id))
        .map((capability) => ({
          capability,
          score: scoreCapability(capability, query),
        }))
        .filter((candidate) => !query || candidate.score > 0)
        .sort(compareCandidates);

      return {
        capabilities: capabilities
          .slice(0, limit)
          .map((candidate) => candidate.capability),
        query,
        total: capabilities.length,
        limit,
        hasMore: capabilities.length > limit,
      };
    },

    async resolve(input) {
      const id = input.id.trim();
      if (!id || id.length > 512) {
        return null;
      }

      const allowlist = normalizeCapabilityAllowlist(input.allowlist);
      if (allowlist && !allowlist.has(id)) {
        return null;
      }

      const source = sourceForCapabilityId(id);
      const tenantOptions = { tenantId: input.tenantId };
      const tool = source === "mcp"
        ? await dependencies.resolveMcp(id, tenantOptions)
        : source === "openapi"
          ? await dependencies.resolveOpenApi(id, tenantOptions)
          : await dependencies.resolveNative(id);

      return tool?.status === "active"
        ? toCapabilityDescriptor(tool, source)
        : null;
    },
  };
}

const defaultCatalog = createCapabilityCatalog();

export function searchCapabilities(input: CapabilitySearchInput) {
  return defaultCatalog.search(input);
}

export function resolveCapability(input: CapabilityResolveInput) {
  return defaultCatalog.resolve(input);
}

export function normalizeCapabilityQuery(query?: string) {
  return (query || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CAPABILITY_MAX_QUERY_LENGTH);
}

export function normalizeCapabilityLimit(limit?: number) {
  if (!Number.isFinite(limit)) {
    return CAPABILITY_DEFAULT_LIMIT;
  }
  return Math.min(
    Math.max(Math.floor(limit as number), 1),
    CAPABILITY_MAX_LIMIT,
  );
}

export function normalizeCapabilityAllowlist(
  allowlist?: readonly string[],
): ReadonlySet<string> | undefined {
  if (allowlist === undefined) {
    return undefined;
  }

  const normalized = new Set<string>();
  for (const entry of allowlist) {
    const id = entry.trim().slice(0, 512);
    if (id) {
      normalized.add(id);
    }
    if (normalized.size >= CAPABILITY_MAX_ALLOWLIST_ENTRIES) {
      break;
    }
  }
  return normalized;
}

function normalizeActiveTools(
  tools: readonly CapabilityCatalogItem[],
  source: CapabilitySource,
) {
  return tools.flatMap((tool) => {
    if (isToolDefinition(tool)) {
      return tool.status === "active"
        ? [toCapabilityDescriptor(tool, source)]
        : [];
    }
    return [normalizeCapabilityDescriptor(tool, source)];
  });
}

function toCapabilityDescriptor(
  tool: ToolDefinition,
  source: CapabilitySource,
): CapabilityDescriptor {
  return {
    id: tool.id,
    name: compactText(tool.name, 120),
    description: compactText(tool.description, 240),
    category: tool.category,
    source,
    riskLevel: tool.riskLevel,
    approvalRequired: tool.approvalRequired,
    reversible: tool.reversible === true,
  };
}

function normalizeCapabilityDescriptor(
  capability: CapabilityDescriptor,
  source: CapabilitySource,
): CapabilityDescriptor {
  return {
    id: compactText(capability.id, 512),
    name: compactText(capability.name, 120),
    description: compactText(capability.description, 240),
    category: capability.category,
    source,
    riskLevel: capability.riskLevel,
    approvalRequired: capability.approvalRequired,
    reversible: capability.reversible === true,
  };
}

function isToolDefinition(
  item: CapabilityCatalogItem,
): item is ToolDefinition {
  return "status" in item && "inputSchema" in item;
}

function compactText(value: string, maxLength: number) {
  return value
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function deduplicateCapabilities(capabilities: CapabilityDescriptor[]) {
  return [...new Map(
    capabilities.map((capability) => [capability.id, capability]),
  ).values()];
}

function sourceForCapabilityId(id: string): CapabilitySource {
  if (id.startsWith("mcp:")) {
    return "mcp";
  }
  if (id.startsWith("openapi:")) {
    return "openapi";
  }
  return "native";
}

function sourcesForSearch(
  allowlist: ReadonlySet<string> | undefined,
  requested?: readonly CapabilitySource[],
): Set<CapabilitySource> {
  const sources = requested === undefined
    ? new Set<CapabilitySource>(["native", "mcp", "openapi"])
    : new Set(
        requested.filter(
          (source): source is CapabilitySource =>
            source === "native" || source === "mcp" || source === "openapi",
        ),
      );
  if (!allowlist) {
    return sources;
  }
  const allowedSources = new Set([...allowlist].map(sourceForCapabilityId));
  return new Set([...sources].filter((source) => allowedSources.has(source)));
}

function scoreCapability(
  capability: CapabilityDescriptor,
  query: string,
) {
  if (!query) {
    return 1;
  }

  const needle = searchText(query);
  if (!needle) {
    return 0;
  }
  const id = searchText(capability.id);
  const name = searchText(capability.name);
  const description = searchText(capability.description);
  const metadata = searchText(
    `${capability.category} ${capability.source}`,
  );
  const tokens = [...new Set(needle.split(" ").filter(Boolean))].slice(0, 12);
  let score = 0;

  if (id === needle) score += 1_000;
  if (name === needle) score += 900;
  if (name.startsWith(needle)) score += 360;
  if (id.startsWith(needle)) score += 320;
  if (name.includes(needle)) score += 240;
  if (id.includes(needle)) score += 200;
  if (description.includes(needle)) score += 80;
  if (metadata.includes(needle)) score += 70;

  for (const token of tokens) {
    if (name.includes(token)) score += 60;
    if (id.includes(token)) score += 45;
    if (metadata.includes(token)) score += 30;
    if (description.includes(token)) score += 15;
  }

  return score;
}

function searchText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compareCandidates(
  first: { capability: CapabilityDescriptor; score: number },
  second: { capability: CapabilityDescriptor; score: number },
) {
  if (first.score !== second.score) {
    return second.score - first.score;
  }
  const sourceOrder: Record<CapabilitySource, number> = {
    native: 0,
    mcp: 1,
    openapi: 2,
  };
  if (first.capability.source !== second.capability.source) {
    return sourceOrder[first.capability.source] - sourceOrder[second.capability.source];
  }
  return first.capability.name.localeCompare(second.capability.name) ||
    first.capability.id.localeCompare(second.capability.id);
}
