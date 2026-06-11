import type { ToolDefinition } from "@/lib/tools/types";

export const governedTools: ToolDefinition[] = [
  {
    id: "memory.search",
    name: "Search Memory",
    description: "Read-only hybrid search over durable memories.",
    category: "memory",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: true,
    inputSchema: objectSchema({
      query: { type: "string", description: "Search query." },
      limit: { type: "number", description: "Maximum number of results.", default: 5 },
    }),
  },
  {
    id: "knowledge.search",
    name: "Search Knowledge",
    description: "Read-only hybrid search over RAG source chunks.",
    category: "knowledge",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: true,
    inputSchema: objectSchema({
      query: { type: "string", description: "Search query." },
      limit: { type: "number", description: "Maximum number of results.", default: 5 },
    }),
  },
  {
    id: "web.search",
    name: "Live Web Search",
    description: "Read-only live web research for current facts, breaking releases, prices, schedules, and source-backed answers.",
    category: "web",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: true,
    inputSchema: objectSchema({
      query: { type: "string", description: "Live web search query." },
      limit: { type: "number", description: "Maximum number of source URLs to return.", default: 8 },
      searchContextSize: { type: "string", enum: ["low", "medium", "high"], default: "medium" },
      allowedDomains: { type: "array", items: { type: "string" } },
    }),
  },
  {
    id: "memory.write",
    name: "Write Memory",
    description: "Persist a durable memory record with optional embedding.",
    category: "memory",
    status: "active",
    riskLevel: 1,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: true,
    inputSchema: objectSchema({
      title: { type: "string" },
      content: { type: "string" },
      type: { type: "string", enum: ["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"] },
      tags: { type: "array", items: { type: "string" } },
      importance: { type: "number", minimum: 0, maximum: 1 },
    }),
  },
  {
    id: "knowledge.ingest",
    name: "Ingest Knowledge",
    description: "Chunk, embed, and store source text as retrievable knowledge.",
    category: "knowledge",
    status: "active",
    riskLevel: 1,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: true,
    inputSchema: objectSchema({
      title: { type: "string" },
      content: { type: "string" },
      source: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    }),
  },
  {
    id: "runs.list",
    name: "List Runs",
    description: "Read recent run ledger entries.",
    category: "runs",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: true,
    inputSchema: objectSchema({
      limit: { type: "number", description: "Maximum number of runs.", default: 5 },
    }),
  },
  {
    id: "http.request",
    name: "HTTP Request",
    description:
      "Send an HTTP request to a public endpoint (webhooks, REST APIs). SSRF-guarded: private networks, internal hostnames, and embedded credentials are blocked. Requires human approval before it executes.",
    category: "connector",
    status: "active",
    riskLevel: 2,
    dryRunSupported: true,
    approvalRequired: true,
    reversible: false,
    inputSchema: objectSchema({
      url: { type: "string", description: "Public http(s) URL to call." },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
      headers: {
        type: "object",
        description: "Optional request headers. Reference secrets by env var name via authEnv instead of pasting values.",
        additionalProperties: { type: "string" },
      },
      body: { type: "string", description: "Optional request body (string; JSON should be pre-serialized)." },
      authEnv: {
        type: "string",
        description: "Optional env var name (OMNIAGENT_CONNECTOR_* or allowlisted) whose value is sent as a Bearer token.",
      },
    }),
  },
];

export function getGovernedTools() {
  return governedTools;
}

export function getGovernedTool(toolId: string) {
  return governedTools.find((tool) => tool.id === toolId);
}

function objectSchema(properties: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
  };
}
