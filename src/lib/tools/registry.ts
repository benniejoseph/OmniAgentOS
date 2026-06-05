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
    inputSchema: objectSchema({
      query: { type: "string", description: "Search query." },
      limit: { type: "number", description: "Maximum number of results.", default: 5 },
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
    inputSchema: objectSchema({
      limit: { type: "number", description: "Maximum number of runs.", default: 5 },
    }),
  },
  {
    id: "connector.external_action",
    name: "External Action",
    description: "Placeholder for future side-effecting connectors; requires approval.",
    category: "connector",
    status: "planned",
    riskLevel: 2,
    dryRunSupported: true,
    approvalRequired: true,
    inputSchema: objectSchema({
      connector: { type: "string" },
      action: { type: "string" },
      payload: { type: "object" },
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
