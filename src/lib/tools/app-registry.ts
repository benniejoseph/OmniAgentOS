import type { ToolDefinition } from "@/lib/tools/types";

export const FIRST_PARTY_APP_TOOLS = Object.freeze([
  readTool("app.workspaces.summary", "Workspace summary", "Read the current tenant workspace summary, including recent runs, workflows, and permitted approval items.", objectSchema({
    limit: integer(1, 50, 16),
    approvalLimit: integer(1, 25, 12),
  })),
  readTool("app.workspaces.readiness", "Workspace readiness", "Read the authenticated tenant workspace readiness checks.", objectSchema({})),
  readTool("app.projects.list", "List projects", "List the current actor's projects with their work items and artifacts.", objectSchema({
    limit: integer(1, 100, 50),
    status: { type: "string", enum: ["draft", "active", "completed", "archived"] },
  })),
  readTool("app.projects.show", "Show project", "Read one exact actor-owned project with its work items and artifacts.", requiredObjectSchema({
    projectId: uuid("Exact project ID."),
    taskLimit: integer(1, 200, 100),
    artifactLimit: integer(1, 200, 100),
  }, ["projectId"])),
  mutationTool("app.projects.create", "Create project", "Create one actor-owned project with an explicit objective.", requiredObjectSchema({
    title: text(1, 180),
    objective: text(1, 2_000),
    status: { type: "string", enum: ["draft", "active"], default: "active" },
    targetDate: { type: "string", format: "date-time" },
  }, ["title", "objective"]), { reversible: true }),
  mutationTool("app.projects.update", "Update project", "Update one exact actor-owned project, including its lifecycle status.", requiredObjectSchema({
    projectId: uuid("Exact project ID."),
    title: text(1, 180),
    objective: text(1, 2_000),
    status: { type: "string", enum: ["draft", "active", "completed", "archived"] },
    targetDate: { type: ["string", "null"], format: "date-time" },
  }, ["projectId"]), { reversible: true }),
  mutationTool("app.work_items.create", "Create project work item", "Create one work item in an exact active project.", requiredObjectSchema({
    projectId: uuid("Exact owning project ID."),
    title: text(1, 240),
    detail: text(0, 1_000),
    priority: { type: "string", enum: ["low", "medium", "high"], default: "medium" },
    agentId: { type: "string", enum: ["atlas", "scout", "forge", "sentinel", "mnemosyne"], default: "atlas" },
    dueAt: { type: "string", format: "date-time" },
  }, ["projectId", "title"]), { reversible: true }),
  mutationTool("app.work_items.update", "Update project work item", "Update one exact work item inside its exact active project.", requiredObjectSchema({
    projectId: uuid("Exact owning project ID."),
    workItemId: uuid("Exact work-item ID."),
    title: text(1, 240),
    detail: text(0, 1_000),
    status: { type: "string", enum: ["open", "doing", "done"] },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    agentId: { type: "string", enum: ["atlas", "scout", "forge", "sentinel", "mnemosyne"] },
    dueAt: { type: ["string", "null"], format: "date-time" },
  }, ["projectId", "workItemId"]), { reversible: true }),
  readTool("app.memory.list", "List memory", "List durable memories visible to the current actor, optionally for one owned thread.", objectSchema({
    limit: integer(1, 100, 20),
    threadId: text(1, 200),
  })),
  readTool("app.memory.search", "Search memory", "Search durable memory visible to the current actor.", requiredObjectSchema({
    query: text(1, 4_000),
    limit: integer(1, 100, 20),
  }, ["query"])),
  readTool("app.memory.inspect", "Inspect memory", "Inspect one exact memory and its provenance without exposing its embedding.", requiredObjectSchema({
    id: text(1, 200),
  }, ["id"])),
  mutationTool("app.memory.write", "Write memory", "Write one actor-scoped durable memory through the governed memory service.", requiredObjectSchema({
    title: text(1, 240), content: text(1, 200_000),
    type: { type: "string", enum: ["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"] },
    tier: { type: "string", enum: ["working", "episodic", "semantic", "procedural", "preference", "decision", "commitment", "summary"] },
    tags: { type: "array", maxItems: 50, items: text(1, 80) },
    importance: { type: "number", minimum: 0, maximum: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidenceRefs: { type: "array", maxItems: 50, items: text(1, 500) },
    validFrom: { type: "string", format: "date-time" }, validTo: { type: "string", format: "date-time" },
  }, ["title", "content"]), { reversible: true }),
  mutationTool("app.memory.correct", "Correct memory", "Create a corrected successor for one exact memory while preserving history.", requiredObjectSchema({
    id: text(1, 200), title: text(1, 240), content: text(1, 200_000),
    confidence: { type: "number", minimum: 0, maximum: 1 },
    validTo: { type: "string", format: "date-time" }, contradiction: { type: "boolean" },
  }, ["id"]), { reversible: true }),
  mutationTool("app.memory.lifecycle", "Change memory lifecycle", "Pin, unpin, archive, or restore one exact memory.", requiredObjectSchema({
    id: text(1, 200), action: { type: "string", enum: ["pin", "unpin", "archive", "restore"] },
  }, ["id", "action"]), { reversible: true }),
  readTool("app.memory.forget.preview", "Preview memory deletion", "Preview the exact records and projections affected by permanently forgetting one memory.", requiredObjectSchema({
    id: text(1, 200),
  }, ["id"])),
  mutationTool("app.memory.forget", "Forget memory", "Permanently scrub one exact memory only when its deletion-preview digest still matches.", requiredObjectSchema({
    id: text(1, 200),
    expectedReceiptManifestSha256: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" },
  }, ["id", "expectedReceiptManifestSha256"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.memory.export", "Export memory", "Return the authenticated owner-only portable memory archive route without copying archive contents into the transcript.", objectSchema({})),
  readTool("app.knowledge.list", "List knowledge", "List tenant-scoped knowledge sources without chunk bodies.", objectSchema({ limit: integer(1, 100, 20) })),
  readTool("app.knowledge.search", "Search knowledge", "Search tenant-scoped knowledge chunks.", requiredObjectSchema({ query: text(1, 4_000), limit: integer(1, 100, 20) }, ["query"])),
  mutationTool("app.knowledge.ingest", "Ingest knowledge", "Chunk, embed, and store one bounded knowledge source.", requiredObjectSchema({
    title: text(1, 240), content: text(1, 20_000), source: text(0, 2_000),
    tags: { type: "array", maxItems: 50, items: text(1, 80) },
  }, ["title", "content"]), { reversible: true }),
  readTool("app.knowledge.delete.preview", "Preview knowledge-source deletion", "List the exact knowledge documents currently matched by a supported connected-source prefix and return their digest.", requiredObjectSchema({
    source: { type: "string", enum: ["google:", "google:mail:", "google:calendar:", "google:drive:"] },
  }, ["source"])),
  mutationTool("app.knowledge.delete", "Delete knowledge source", "Delete the exact knowledge-source target set only when its current digest matches the prior preview.", requiredObjectSchema({
    source: { type: "string", enum: ["google:", "google:mail:", "google:calendar:", "google:drive:"] },
    expectedTargetsSha256: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" },
  }, ["source", "expectedTargetsSha256"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
] satisfies readonly ToolDefinition[]);

function readTool(id: string, name: string, description: string, inputSchema: Record<string, unknown>): ToolDefinition {
  return { id, name, description, category: "app", status: "active", riskLevel: 0, dryRunSupported: true, approvalRequired: false, operationClass: "read_only", reversible: true, inputSchema };
}

function mutationTool(
  id: string,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  options: { riskLevel?: 1 | 2 | 3; approvalRequired?: boolean; reversible?: boolean } = {},
): ToolDefinition {
  return {
    id, name, description, inputSchema, category: "app", status: "active",
    riskLevel: options.riskLevel || 1,
    dryRunSupported: true,
    approvalRequired: options.approvalRequired || false,
    operationClass: "mutation",
    reversible: options.reversible ?? false,
  };
}

function objectSchema(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, properties };
}

function requiredObjectSchema(properties: Record<string, unknown>, required: string[]) {
  return { ...objectSchema(properties), required };
}

function text(minLength: number, maxLength: number) {
  return { type: "string", minLength, maxLength };
}

function integer(minimum: number, maximum: number, defaultValue?: number) {
  return { type: "integer", minimum, maximum, ...(defaultValue === undefined ? {} : { default: defaultValue }) };
}

function uuid(description: string) {
  return { type: "string", format: "uuid", description };
}
