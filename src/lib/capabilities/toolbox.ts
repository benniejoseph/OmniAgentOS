import { createHash } from "node:crypto";
import {
  getMcpGovernedTool,
  getOpenApiGovernedTool,
} from "@/lib/connectors/governed-tools";
import { searchCapabilities } from "@/lib/capabilities/catalog";
import type {
  CapabilityDescriptor,
  CapabilitySearchInput,
  CapabilitySearchResult,
} from "@/lib/capabilities/types";
import { getGovernedTools } from "@/lib/tools/registry";
import type { ToolDefinition } from "@/lib/tools/types";

export const AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT = 6;
export const AGENT_EXTERNAL_TOOL_ALLOWLIST_LIMIT = 12;
export const AGENT_TOOL_SCHEMA_MAX_BYTES = 16 * 1024;
export const AGENT_TOOL_SCHEMA_RUN_MAX_BYTES = 64 * 1024;

type ProgressiveToolboxDependencies = {
  listNative: () => readonly ToolDefinition[];
  search: (input: CapabilitySearchInput) => Promise<CapabilitySearchResult>;
  resolveMcp: (id: string, tenantId?: string) => Promise<ToolDefinition | null>;
  resolveOpenApi: (id: string, tenantId?: string) => Promise<ToolDefinition | null>;
};

const defaultDependencies: ProgressiveToolboxDependencies = {
  listNative: getGovernedTools,
  search: searchCapabilities,
  resolveMcp: (id, tenantId) => getMcpGovernedTool(id, { tenantId }),
  resolveOpenApi: (id, tenantId) => getOpenApiGovernedTool(id, { tenantId }),
};

export type ProgressiveAgentToolboxInput = {
  tenantId?: string;
  excludeToolIds?: readonly string[];
  query?: string;
  preferredToolIds?: readonly string[];
};

export type ToolSchemaBudgetResult = {
  definitions: ToolDefinition[];
  omittedToolIds: string[];
  schemaBytes: number;
};

/**
 * Keeps discovery cheap: connector search returns metadata only, then at most
 * six relevant (or twelve explicitly allowlisted) contracts are hydrated.
 */
export async function loadProgressiveAgentTools(
  input: ProgressiveAgentToolboxInput,
  dependencies: ProgressiveToolboxDependencies = defaultDependencies,
): Promise<ToolSchemaBudgetResult> {
  const excluded = new Set(input.excludeToolIds || []);
  const hasExplicitAllowlist = input.preferredToolIds !== undefined;
  const preferred = new Set(input.preferredToolIds || []);
  const nativeDefinitions = dependencies.listNative().filter(
    (tool) =>
      tool.status === "active" &&
      tool.riskLevel < 3 &&
      !excluded.has(tool.id) &&
      (!hasExplicitAllowlist || preferred.has(tool.id)),
  );

  const externalAllowlist = hasExplicitAllowlist
    ? [...preferred].filter(isExternalCapabilityId)
    : undefined;
  const externalLimit = hasExplicitAllowlist
    ? AGENT_EXTERNAL_TOOL_ALLOWLIST_LIMIT
    : AGENT_EXTERNAL_TOOL_DEFAULT_LIMIT;
  let descriptors: CapabilityDescriptor[] = [];

  if (!hasExplicitAllowlist || externalAllowlist?.length) {
    const searchInput = {
      tenantId: input.tenantId || "default",
      query: input.query,
      // The catalog still returns only compact metadata. Asking for its public
      // maximum lets semantic scoring see the full bounded candidate window
      // before just six contracts are hydrated.
      limit: 50,
      allowlist: externalAllowlist,
      sources: ["mcp", "openapi"],
    } satisfies CapabilitySearchInput;
    let capabilities = await searchExternalMetadata(searchInput, dependencies.search);
    if (
      hasExplicitAllowlist &&
      input.query?.trim() &&
      capabilities.length === 0
    ) {
      capabilities = await searchExternalMetadata(
        { ...searchInput, query: undefined },
        dependencies.search,
      );
    }
    descriptors = capabilities
      .filter(
        (capability) =>
          isExternalCapabilityId(capability.id) &&
          capability.riskLevel < 3 &&
          !excluded.has(capability.id),
      )
      .slice(0, externalLimit);
  }

  const hydrated = await Promise.all(
    descriptors.map(async (descriptor) => {
      try {
        return descriptor.source === "mcp"
          ? await dependencies.resolveMcp(descriptor.id, input.tenantId)
          : await dependencies.resolveOpenApi(descriptor.id, input.tenantId);
      } catch {
        return null;
      }
    }),
  );
  const externalDefinitions = hydrated.filter(
    (tool): tool is ToolDefinition =>
      Boolean(
        tool &&
        tool.status === "active" &&
        tool.riskLevel < 3 &&
        !excluded.has(tool.id) &&
        (!hasExplicitAllowlist || preferred.has(tool.id)),
      ),
  );

  return applyToolSchemaBudget(
    deduplicateDefinitions([...nativeDefinitions, ...externalDefinitions]),
  );
}

export function applyToolSchemaBudget(
  definitions: readonly ToolDefinition[],
  options: {
    perToolBytes?: number;
    perRunBytes?: number;
  } = {},
): ToolSchemaBudgetResult {
  const perToolBytes = normalizeByteBudget(
    options.perToolBytes,
    AGENT_TOOL_SCHEMA_MAX_BYTES,
  );
  const perRunBytes = normalizeByteBudget(
    options.perRunBytes,
    AGENT_TOOL_SCHEMA_RUN_MAX_BYTES,
  );
  const accepted: ToolDefinition[] = [];
  const omittedToolIds: string[] = [];
  let schemaBytes = 0;

  for (const definition of definitions) {
    const bytes = serializedSchemaBytes(definition.inputSchema);
    if (bytes === null || bytes > perToolBytes || schemaBytes + bytes > perRunBytes) {
      omittedToolIds.push(definition.id);
      continue;
    }
    accepted.push(definition);
    schemaBytes += bytes;
  }

  return { definitions: accepted, omittedToolIds, schemaBytes };
}

/** Stable across ordering, processes, and retries; safe for model function names. */
export function capabilityFunctionName(toolId: string) {
  const hash = createHash("sha256").update(toolId).digest("hex").slice(0, 16);
  const prefix = toolId
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 43) || "tool";
  return `${prefix}_${hash}`;
}

function isExternalCapabilityId(id: string) {
  return id.startsWith("mcp:") || id.startsWith("openapi:");
}

function deduplicateDefinitions(definitions: readonly ToolDefinition[]) {
  return [...new Map(definitions.map((definition) => [definition.id, definition])).values()];
}

function serializedSchemaBytes(schema: Record<string, unknown>) {
  try {
    return Buffer.byteLength(JSON.stringify(schema), "utf8");
  } catch {
    return null;
  }
}

function normalizeByteBudget(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value as number));
}

async function searchExternalMetadata(
  input: CapabilitySearchInput,
  search: ProgressiveToolboxDependencies["search"],
) {
  try {
    return (await search(input)).capabilities;
  } catch {
    const settled = await Promise.all(
      (["mcp", "openapi"] as const).map((source) =>
        search({ ...input, sources: [source] })
          .then((result) => result.capabilities)
          .catch(() => [] as CapabilityDescriptor[]),
      ),
    );
    const merged: CapabilityDescriptor[] = [];
    const maxLength = Math.max(...settled.map((items) => items.length), 0);
    for (let index = 0; index < maxLength; index += 1) {
      for (const items of settled) {
        const item = items[index];
        if (item) merged.push(item);
      }
    }
    return merged;
  }
}
