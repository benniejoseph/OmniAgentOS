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
  readTool("app.today.show", "Show Today", "Read the current actor's Today snapshot.", objectSchema({})),
  mutationTool("app.today.item.create", "Create Today item", "Create one task or reminder in Today.", requiredObjectSchema({
    title: text(1, 280), kind: { type: "string", enum: ["task", "reminder"], default: "task" },
    priority: { type: "string", enum: ["low", "medium", "high"], default: "medium" }, dueAt: { type: "string", format: "date-time" },
  }, ["title"]), { reversible: true }),
  mutationTool("app.today.item.update", "Update Today item", "Update one exact Today task or reminder.", requiredObjectSchema({
    itemId: opaqueId("Exact Today-item ID."), title: text(1, 280), status: { type: "string", enum: ["open", "done"] },
    priority: { type: "string", enum: ["low", "medium", "high"] }, dueAt: { type: ["string", "null"], format: "date-time" },
  }, ["itemId"]), { reversible: true }),
  readTool("app.today.brief.show", "Show daily brief", "Read the current actor's daily brief and preferences.", objectSchema({})),
  mutationTool("app.today.brief.generate", "Generate daily brief", "Generate or refresh the current actor's daily brief.", objectSchema({ force: { type: "boolean", default: false } }), { reversible: true }),
  mutationTool("app.today.preferences.update", "Update Today preferences", "Update daily brief, reminder, notification, timezone, or quiet-hours preferences.", objectSchema({
    briefEnabled: { type: "boolean" }, briefTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    timezone: text(1, 120), reminderLeadMinutes: { type: "integer", enum: [5, 15, 30, 60, 120] },
    notificationsEnabled: { type: "boolean" }, quietHoursEnabled: { type: "boolean" },
    quietHoursStart: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }, quietHoursEnd: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
  }), { reversible: true }),
  readTool("app.notifications.list", "List notifications", "Read the current actor's notification center without generating new reminders.", objectSchema({})),
  mutationTool("app.notifications.update", "Update notification", "Read, dismiss, snooze, or complete one exact personal notification.", requiredObjectSchema({
    notificationId: opaqueId("Exact personal-notification ID."), action: { type: "string", enum: ["read", "dismiss", "snooze", "complete"] },
    minutes: { type: "integer", enum: [5, 15, 30, 60, 120, 1440] },
  }, ["notificationId", "action"]), { reversible: false }),
  mutationTool("app.notifications.read_all", "Read all notifications", "Mark all of the current actor's unread notifications as read.", objectSchema({}), { reversible: false }),
  readTool("app.runs.list", "List agent runs", "List recent tenant-scoped agent runs and optional aggregate statistics.", objectSchema({
    limit: integer(1, 100, 20), includeStats: { type: "boolean", default: false },
  })),
  readTool("app.runs.show", "Show agent run", "Read one exact tenant-scoped agent run and its context-use receipt.", requiredObjectSchema({
    runId: opaqueId("Exact agent-run ID."),
  }, ["runId"])),
  mutationTool("app.runs.feedback", "Rate agent run", "Record explicit useful or needs-work feedback for one completed run and apply its governed trust and memory consequences.", requiredObjectSchema({
    runId: opaqueId("Exact completed agent-run ID."), verdict: { type: "string", enum: ["useful", "needs_work"] }, correction: text(0, 2_000),
  }, ["runId", "verdict"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  mutationTool("app.runs.cancel", "Cancel agent run", "Cancel one exact active run and its queued execution or resume deliveries.", requiredObjectSchema({
    runId: opaqueId("Exact agent-run ID."), reason: text(1, 500),
  }, ["runId"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.agents.list", "List agents", "List built-in agents and custom agents readable by the current actor.", objectSchema({
    ownerScope: { type: "string", enum: ["exact", "readable"], default: "readable" },
  })),
  readTool("app.agents.show", "Show agent", "Read one exact built-in or custom agent.", requiredObjectSchema({
    id: opaqueId("Exact agent ID."), includeBuiltIns: { type: "boolean", default: true },
  }, ["id"])),
  mutationTool("app.agents.create", "Create custom agent", "Create one custom agent with bounded skills, tools, memory, model, and approval policy.", requiredObjectSchema(agentProperties(), ["name", "role", "description", "instructions"]), { reversible: true }),
  mutationTool("app.agents.update", "Update custom agent", "Update one exact custom agent.", requiredObjectSchema({
    id: opaqueId("Exact custom-agent ID."), change: objectSchema(agentProperties()),
  }, ["id", "change"]), { reversible: true }),
  readTool("app.agents.delete.preview", "Preview custom-agent deletion", "Preview the exact custom agent, skill assignments, and tool assignments that permanent deletion will retire.", requiredObjectSchema({ id: opaqueId("Exact custom-agent ID.") }, ["id"])),
  mutationTool("app.agents.delete", "Delete custom agent", "Permanently retire and delete one exact custom agent only when its preview digest still matches.", requiredObjectSchema({
    id: opaqueId("Exact custom-agent ID."), expectedTargetSha256: sha256("Digest returned by app.agents.delete.preview."),
  }, ["id", "expectedTargetSha256"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.skills.list", "List skills", "List built-in and custom skills readable by the current actor.", objectSchema({})),
  readTool("app.skills.show", "Show skill", "Read one exact built-in or custom skill.", requiredObjectSchema({ id: opaqueId("Exact skill ID.") }, ["id"])),
  mutationTool("app.skills.create", "Create skill", "Create one custom skill with bounded instructions and tool assignments.", requiredObjectSchema(skillProperties(), ["name", "description", "instructions", "category"]), { reversible: true }),
  mutationTool("app.skills.update", "Update skill", "Update one exact custom skill.", requiredObjectSchema({
    id: opaqueId("Exact custom-skill ID."), change: objectSchema(skillProperties()),
  }, ["id", "change"]), { reversible: true }),
  readTool("app.skills.delete.preview", "Preview skill deletion", "Preview the exact custom skill and affected custom agents before permanent deletion.", requiredObjectSchema({ id: opaqueId("Exact custom-skill ID.") }, ["id"])),
  mutationTool("app.skills.delete", "Delete skill", "Permanently delete one exact custom skill only when its target preview still matches.", requiredObjectSchema({
    id: opaqueId("Exact custom-skill ID."), expectedTargetSha256: sha256("Digest returned by app.skills.delete.preview."),
  }, ["id", "expectedTargetSha256"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.workflows.list", "List workflows", "List tenant-scoped workflow runs with optional queue and aggregate status.", objectSchema({
    limit: integer(1, 100, 20), includeStats: { type: "boolean", default: true }, includeQueue: { type: "boolean", default: true },
  })),
  readTool("app.workflows.show", "Show workflow", "Read one exact tenant-scoped workflow with its step detail.", requiredObjectSchema({ workflowId: opaqueId("Exact workflow-run ID.") }, ["workflowId"])),
  readTool("app.workflows.plans.list", "List workflow plans", "List recent tenant-scoped workflow plans and planning statistics.", objectSchema({ limit: integer(1, 100, 20) })),
  mutationTool("app.workflows.plan", "Plan workflow", "Create a bounded workflow plan for an explicit goal without starting execution.", requiredObjectSchema({
    goal: text(1, 4_000), mode: workflowMode(), requireApproval: { type: "boolean", default: false }, reuseExisting: { type: "boolean", default: true },
  }, ["goal"]), { reversible: true }),
  readTool("app.workflows.executions.list", "List workflow executions", "List tenant-scoped workflow plan-node executions and statistics.", objectSchema({ limit: integer(1, 200, 50) })),
  mutationTool("app.workflows.start", "Start workflow", "Create and enqueue one idempotent workflow for an explicit goal and bounded budget.", requiredObjectSchema({
    goal: text(1, 4_000), mode: workflowMode(), requireApproval: { type: "boolean", default: false },
    maxAttempts: integer(1, 5, 3), budgets: workflowBudgetsSchema(),
  }, ["goal"]), { reversible: true }),
  mutationTool("app.workflows.signal", "Signal workflow", "Pause, resume, cancel, approve, or retry one exact workflow.", requiredObjectSchema({
    workflowId: opaqueId("Exact workflow-run ID."), signal: { type: "string", enum: ["pause", "resume", "cancel", "approve", "retry"] },
  }, ["workflowId", "signal"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  mutationTool("app.workflows.tick", "Tick workflow", "Process at most one queued step for one exact workflow; consequential tools retain their own approval gates.", requiredObjectSchema({
    workflowId: opaqueId("Exact workflow-run ID."),
  }, ["workflowId"]), { reversible: false }),
  readTool("app.connectors.list", "List connectors", "List tenant-scoped MCP and OpenAPI connectors with reviewed contract summaries.", objectSchema({
    kind: connectorKind(), limit: integer(1, 100, 20),
  })),
  readTool("app.connectors.show", "Show connector", "Read one exact connector and its discovered tools or imported operations.", requiredObjectSchema({
    kind: connectorKind(), connectorId: opaqueId("Exact connector ID."),
  }, ["kind", "connectorId"])),
  mutationTool("app.connectors.register", "Register connector", "Register one MCP or OpenAPI connector using no auth or a deployer-managed environment binding; raw credentials are never accepted.", requiredObjectSchema({
    kind: connectorKind(), name: text(1, 120), endpoint: { type: "string", format: "uri", maxLength: 2_048 },
    specUrl: { type: "string", format: "uri", maxLength: 2_048 }, baseUrl: { type: "string", format: "uri", maxLength: 2_048 },
    authType: { type: "string", enum: ["none", "bearer_env", "api_key_header_env"], default: "none" },
    authTokenEnv: { type: "string", pattern: "^[A-Z0-9_]+$", maxLength: 120 }, authHeaderName: text(1, 80),
    defaultRiskLevel: { type: "integer", enum: [0, 1, 2, 3], default: 2 }, approvalRequired: { type: "boolean", default: true },
  }, ["kind", "name"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.connectors.update", "Update connector", "Update one exact connector; contract-changing updates disable it until refresh and review.", requiredObjectSchema({
    kind: connectorKind(), connectorId: opaqueId("Exact connector ID."), name: text(1, 120),
    endpoint: { type: "string", format: "uri", maxLength: 2_048 }, specUrl: { type: ["string", "null"], format: "uri", maxLength: 2_048 },
    baseUrl: { type: "string", format: "uri", maxLength: 2_048 }, status: { type: "string", enum: ["active", "error", "disabled"] },
    defaultRiskLevel: { type: "integer", enum: [0, 1, 2, 3] }, approvalRequired: { type: "boolean" },
  }, ["kind", "connectorId"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.connectors.refresh", "Refresh connector contracts", "Discover MCP tools or import an OpenAPI spec from a public URL, leaving changed contracts pending review.", requiredObjectSchema({
    kind: connectorKind(), connectorId: opaqueId("Exact connector ID."), specUrl: { type: "string", format: "uri", maxLength: 2_048 },
    baseUrl: { type: "string", format: "uri", maxLength: 2_048 },
  }, ["kind", "connectorId"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.connectors.review", "Approve connector contracts", "Promote the exact discovered contract set only when its review fingerprint still matches.", requiredObjectSchema({
    kind: connectorKind(), connectorId: opaqueId("Exact connector ID."), expectedFingerprint: text(20, 200),
  }, ["kind", "connectorId", "expectedFingerprint"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.connectors.delete.preview", "Preview connector deletion", "Preview the exact connector and operation IDs removed by permanent deletion.", requiredObjectSchema({
    kind: connectorKind(), connectorId: opaqueId("Exact connector ID."),
  }, ["kind", "connectorId"])),
  mutationTool("app.connectors.delete", "Delete connector", "Permanently delete one connector and its exact operation set only when the preview digest still matches.", requiredObjectSchema({
    kind: connectorKind(), connectorId: opaqueId("Exact connector ID."), expectedTargetSha256: sha256("Digest returned by app.connectors.delete.preview."),
  }, ["kind", "connectorId", "expectedTargetSha256"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.settings.show", "Show settings", "Read the current actor's redacted provider, model, assignment, API-key metadata, MCP exposure, vault readiness, and platform settings.", objectSchema({})),
  readTool("app.settings.models.list", "List models", "List the current actor's selectable model catalog without credentials.", objectSchema({})),
  mutationTool("app.settings.assignments.update", "Update model assignment", "Update one model routing assignment; cross-provider fallback requires explicit disclosure consent.", requiredObjectSchema({
    scope: { type: "string", enum: ["main_agent", "orchestrator", "workflow", "council", "memory", "embeddings", "vision", "audio"] },
    provider: modelProvider(), modelId: text(1, 240), fallbackProvider: modelProvider(), fallbackModelId: text(1, 240),
    crossProviderFallbackConsent: { type: "boolean", enum: [true] },
  }, ["scope", "provider", "modelId"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.settings.mcp.update", "Update MCP exposure", "Update the current actor's first-party MCP export configuration and allowed scopes.", requiredObjectSchema({
    enabled: { type: "boolean" }, serverName: text(1, 120), allowedScopes: serviceApiScopes(), exposeResources: { type: "boolean", default: false },
  }, ["enabled", "serverName", "allowedScopes"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.settings.providers.update", "Update provider metadata", "Rename or enable/disable one exact tenant-vault provider connection without handling credentials.", requiredObjectSchema({
    id: opaqueId("Exact provider-connection ID."), label: text(1, 120), enabled: { type: "boolean" },
  }, ["id"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.settings.providers.validate", "Validate provider", "Validate one exact provider connection and refresh its model catalog.", requiredObjectSchema({
    id: opaqueId("Exact provider-connection ID."),
  }, ["id"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.settings.providers.revoke.preview", "Preview provider revocation", "Preview the exact redacted provider credential record that revocation will scrub.", requiredObjectSchema({ id: opaqueId("Exact provider-connection ID.") }, ["id"])),
  mutationTool("app.settings.providers.revoke", "Revoke provider", "Revoke and scrub one exact tenant-vault provider credential only when the preview digest still matches.", requiredObjectSchema({
    id: opaqueId("Exact provider-connection ID."), expectedTargetSha256: sha256("Digest returned by the provider revocation preview."),
  }, ["id", "expectedTargetSha256"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.settings.api_keys.list", "List service API keys", "List only redacted service API-key metadata for the current actor.", objectSchema({})),
  readTool("app.settings.api_keys.revoke.preview", "Preview API-key revocation", "Preview one exact redacted service API key before revocation.", requiredObjectSchema({ id: opaqueId("Exact service API-key ID.") }, ["id"])),
  mutationTool("app.settings.api_keys.revoke", "Revoke service API key", "Revoke one exact service API key only when its redacted target digest still matches.", requiredObjectSchema({
    id: opaqueId("Exact service API-key ID."), expectedTargetSha256: sha256("Digest returned by the API-key revocation preview."),
  }, ["id", "expectedTargetSha256"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.assets.list", "List captured assets", "List actor-readable uploaded assets and recording metadata without copying stored binary content into the transcript.", objectSchema({
    kind: assetKind(), limit: integer(1, 100, 50),
  })),
  readTool("app.assets.show", "Show captured asset", "Read metadata for one exact uploaded asset or recording without returning stored binary content.", requiredObjectSchema({
    kind: assetKind(), id: opaqueId("Exact capture asset or recording ID."),
  }, ["kind", "id"])),
  mutationTool("app.assets.recordings.start", "Start recording record", "Create a governed recording record that direct user-to-storage audio segments can attach to.", objectSchema(recordingProperties()), { reversible: true }),
  mutationTool("app.assets.recordings.update", "Update recording", "Update the title, language, or tags for one exact recording.", requiredObjectSchema({
    id: opaqueId("Exact recording ID."), ...recordingProperties(),
  }, ["id"]), { reversible: true }),
  mutationTool("app.assets.recordings.complete", "Complete recording", "Finalize and enqueue indexing for one exact recording whose audio segments were uploaded directly by the user.", requiredObjectSchema({
    id: opaqueId("Exact recording ID."),
  }, ["id"]), { reversible: false }),
  readTool("app.assets.delete.preview", "Preview captured-content deletion", "Preview the exact asset, derived knowledge reference, ingest job, and recording segment IDs affected by deletion.", requiredObjectSchema({
    kind: assetKind(), id: opaqueId("Exact capture asset or recording ID."),
  }, ["kind", "id"])),
  mutationTool("app.assets.delete", "Delete captured content", "Permanently delete one exact capture asset or recording and its derived knowledge only when its preview digest still matches.", requiredObjectSchema({
    kind: assetKind(), id: opaqueId("Exact capture asset or recording ID."), expectedTargetSha256: sha256("Digest returned by app.assets.delete.preview."),
  }, ["kind", "id", "expectedTargetSha256"]), { riskLevel: 3, approvalRequired: true, reversible: false }),
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

function opaqueId(description: string) {
  return { type: "string", minLength: 1, maxLength: 200, description };
}

function sha256(description: string) {
  return { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$", description };
}

function idList(maxItems = 50) {
  return { type: "array", maxItems, uniqueItems: true, items: text(1, 120) };
}

function skillProperties(): Record<string, unknown> {
  return {
    name: text(2, 120), description: text(2, 500), instructions: text(10, 12_000),
    category: { type: "string", enum: ["research", "creation", "analysis", "memory", "automation", "personal"] },
    status: { type: "string", enum: ["active", "disabled"], default: "active" },
    toolIds: idList(), tags: { type: "array", maxItems: 30, uniqueItems: true, items: text(1, 100) },
    knowledgeTags: { type: "array", maxItems: 30, uniqueItems: true, items: text(1, 100) },
  };
}

function agentProperties(): Record<string, unknown> {
  return {
    name: text(2, 120), role: text(2, 120), description: text(2, 700), instructions: text(10, 12_000),
    status: { type: "string", enum: ["ready", "learning", "paused"], default: "ready" },
    accent: { type: "string", enum: ["emerald", "blue", "amber", "violet", "rose"], default: "emerald" },
    modelPolicy: { type: "string", enum: ["auto", "openai_fast", "openai_reasoning", "gemini_fast", "anthropic_fast", "anthropic_reasoning"], default: "auto" },
    autonomy: { type: "string", enum: ["assist", "governed", "execute"], default: "governed" },
    approvalPolicy: { type: "string", enum: ["always", "risk_based", "read_only"], default: "risk_based" },
    memoryScope: { type: "string", enum: ["session", "project", "all"], default: "all" },
    skillIds: idList(), toolIds: idList(),
  };
}

function workflowMode() {
  return { type: "string", enum: ["orchestrate", "research", "execute", "learn"], default: "orchestrate" };
}

function workflowBudgetsSchema() {
  return objectSchema({
    toolCalls: integer(0, 1_000), modelCalls: integer(0, 1_000),
    costUnits: integer(0, 1_000_000), elapsedMs: integer(0, 86_400_000),
  });
}

function connectorKind() {
  return { type: "string", enum: ["mcp", "openapi"] };
}

function modelProvider() {
  return { type: "string", enum: ["openai", "google", "anthropic", "aws_bedrock"] };
}

function serviceApiScopes() {
  return {
    type: "array", uniqueItems: true, maxItems: 12,
    items: { type: "string", enum: ["mcp:discover", "mcp:tools:list", "mcp:tools:execute", "a2a:discover", "a2a:tasks:read", "a2a:tasks:write", "missions:read", "missions:write", "memory:read", "memory:write", "runs:read", "settings:read"] },
  };
}

function assetKind() {
  return { type: "string", enum: ["asset", "recording"] };
}

function recordingProperties(): Record<string, unknown> {
  return {
    title: text(0, 240), language: text(0, 35),
    tags: { type: "array", maxItems: 50, uniqueItems: true, items: text(1, 80) },
  };
}
