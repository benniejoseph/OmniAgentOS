export type Capability = {
  id: string;
  name: string;
  description: string;
  status: "active" | "planned";
};

export const agents: Capability[] = [
  {
    id: "planner",
    name: "Planner",
    description: "Breaks goals into ordered tasks, dependencies, risks, and verification gates.",
    status: "active",
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Builds evidence packs from memory, RAG, files, and connected sources.",
    status: "active",
  },
  {
    id: "executor",
    name: "Executor",
    description: "Chooses safe tools, prepares action inputs, and records outcomes.",
    status: "active",
  },
  {
    id: "verifier",
    name: "Verifier",
    description: "Checks outputs against acceptance criteria before a run is considered complete.",
    status: "active",
  },
  {
    id: "memory-curator",
    name: "Memory Curator",
    description: "Extracts durable preferences, facts, procedures, and reusable knowledge.",
    status: "active",
  },
];

export const tools: Capability[] = [
  {
    id: "memory.search",
    name: "Search Memory",
    description: "Hybrid retrieval over long-term memories and ingested knowledge chunks.",
    status: "active",
  },
  {
    id: "memory.write",
    name: "Write Memory",
    description: "Persists facts, preferences, procedures, and task episodes.",
    status: "active",
  },
  {
    id: "rag.ingest",
    name: "Ingest Knowledge",
    description: "Chunks documents, embeds when OpenAI is configured, and stores retrievable context.",
    status: "active",
  },
  {
    id: "tool.executor",
    name: "Governed Tool Executor",
    description: "Runs schema-validated tools through risk policy, dry-runs, approval gates, and audit logging.",
    status: "active",
  },
  {
    id: "connector.mcp",
    name: "MCP Connector",
    description: "Register remote MCP servers as governed tool providers.",
    status: "planned",
  },
  {
    id: "connector.openapi",
    name: "OpenAPI Importer",
    description: "Generate typed tools from OpenAPI schemas with approval policies.",
    status: "planned",
  },
  {
    id: "workflow.temporal",
    name: "Durable Workflow Runtime",
    description: "Move long-running multi-agent jobs onto a durable queue with retries and resumes.",
    status: "planned",
  },
];

export const connectorTypes: Capability[] = [
  {
    id: "mcp",
    name: "MCP Servers",
    description: "Universal tool/resource/prompt bridge for third-party systems.",
    status: "planned",
  },
  {
    id: "rest",
    name: "REST/OpenAPI",
    description: "Import SaaS and internal APIs as approval-gated tools.",
    status: "planned",
  },
  {
    id: "sql",
    name: "SQL/Vector Stores",
    description: "Query operational data and retrieve semantic knowledge.",
    status: "planned",
  },
  {
    id: "webhook",
    name: "Webhooks",
    description: "Trigger agent workflows from external events.",
    status: "planned",
  },
];

export function getCapabilityRegistry() {
  return {
    agents,
    tools,
    connectorTypes,
  };
}
