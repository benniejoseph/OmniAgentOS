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
    id: "memory.correct",
    name: "Correct Memory",
    description:
      "Replace an existing tenant-scoped memory with a corrected version while retaining the prior record as superseded or contradicted.",
    category: "memory",
    status: "active",
    riskLevel: 1,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: true,
    inputSchema: {
      ...objectSchema({
        id: { type: "string", description: "Exact memory record ID to correct.", minLength: 1, maxLength: 200 },
        title: { type: "string", minLength: 1, maxLength: 240 },
        content: { type: "string", minLength: 1, maxLength: 200_000 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        validTo: { type: "string", format: "date-time" },
        contradiction: {
          type: "boolean",
          enum: [true],
          description: "Mark the prior memory as contradicted instead of superseded.",
        },
      }),
      required: ["id"],
      anyOf: [
        { required: ["title"] },
        { required: ["content"] },
        { required: ["confidence"] },
        { required: ["validTo"] },
        { required: ["contradiction"] },
      ],
    },
  },
  {
    id: "memory.forget",
    name: "Forget Memory",
    description:
      "Irreversibly scrub one tenant-scoped memory by its exact ID. Human approval is always required.",
    category: "memory",
    status: "active",
    riskLevel: 2,
    dryRunSupported: true,
    approvalRequired: true,
    reversible: false,
    inputSchema: {
      ...objectSchema({
        id: { type: "string", description: "Exact memory record ID to forget.", minLength: 1, maxLength: 200 },
      }),
      required: ["id"],
    },
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
    id: "missions.list",
    name: "List Missions",
    description:
      "List safe summaries of the current user's missions, optionally filtered by mission status.",
    category: "missions",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: true,
    inputSchema: objectSchema({
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      status: {
        type: "string",
        enum: ["draft", "queued", "running", "waiting", "succeeded", "failed", "canceled", "archived"],
      },
    }),
  },
  {
    id: "mission.show",
    name: "Show Mission",
    description:
      "Read a safe mission-board view with task, attempt, artifact, and comment summaries for one mission owned by the current user.",
    category: "missions",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: true,
    inputSchema: {
      ...objectSchema({
        missionId: { type: "string", format: "uuid", description: "Exact mission ID to read." },
      }),
      required: ["missionId"],
    },
  },
  {
    id: "mission.task.create",
    name: "Create Mission Task",
    description:
      "Create one triage task on a mission owned by the current user. The task is idempotent for this tool call and cannot be marked complete by this tool.",
    category: "missions",
    status: "active",
    riskLevel: 1,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: false,
    inputSchema: {
      ...objectSchema({
        missionId: { type: "string", format: "uuid", description: "Exact mission ID that will own the task." },
        title: { type: "string", minLength: 1, maxLength: 280 },
        instructions: { type: "string", minLength: 1, maxLength: 8_000 },
        definitionOfDone: { type: "string", minLength: 1, maxLength: 2_000 },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"], default: "normal" },
        dependencyIds: {
          type: "array",
          maxItems: 50,
          uniqueItems: true,
          items: { type: "string", format: "uuid" },
        },
        assigneeKey: { type: "string", minLength: 1, maxLength: 160 },
        skillIds: {
          type: "array",
          maxItems: 30,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 120 },
        },
        reviewRequired: { type: "boolean", default: false },
      }),
      required: ["missionId", "title"],
    },
  },
  {
    id: "mission.task.comment",
    name: "Comment on Mission Task",
    description:
      "Append a bounded comment to a task on a mission owned by the current user without changing task execution state.",
    category: "missions",
    status: "active",
    riskLevel: 1,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: false,
    inputSchema: {
      ...objectSchema({
        missionId: { type: "string", format: "uuid", description: "Exact owning mission ID." },
        taskId: { type: "string", format: "uuid", description: "Exact task ID to comment on." },
        body: { type: "string", minLength: 1, maxLength: 4_000 },
      }),
      required: ["missionId", "taskId", "body"],
    },
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
        description: "Optional deployer-bound env var name (OMNIAGENT_CONNECTOR_* or allowlisted).",
      },
      authHeader: {
        type: "string",
        enum: ["authorization", "x-api-key", "x-auth-token", "api-key"],
        description: "Header that receives the secret. Defaults to authorization.",
      },
      authMode: {
        type: "string",
        enum: ["bearer", "basic", "raw"],
        description: "Bearer or Basic for authorization; raw for an API-key header.",
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
