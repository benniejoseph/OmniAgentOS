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
