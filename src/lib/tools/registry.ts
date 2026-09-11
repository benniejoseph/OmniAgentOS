import type { ToolDefinition } from "@/lib/tools/types";
import { FIRST_PARTY_APP_TOOLS } from "@/lib/tools/app-registry";

export const governedTools: ToolDefinition[] = [
  ...FIRST_PARTY_APP_TOOLS,
  {
    id: "calendar.create",
    name: "Create Google Calendar Event",
    description: "Create one event in the connected user's Google Calendar with deterministic idempotency and read-after-write verification.",
    category: "connector",
    status: "active",
    riskLevel: 2,
    dryRunSupported: true,
    approvalRequired: true,
    reversible: true,
    inputSchema: {
      ...objectSchema({
        calendarId: { type: "string", minLength: 1, maxLength: 500, default: "primary" },
        summary: { type: "string", minLength: 1, maxLength: 1_000 },
        description: { type: "string", maxLength: 8_000 },
        location: { type: "string", maxLength: 1_000 },
        start: { type: "string", format: "date-time" },
        end: { type: "string", format: "date-time" },
        timeZone: { type: "string", minLength: 1, maxLength: 100 },
        attendees: { type: "array", maxItems: 50, items: { type: "string", format: "email" } },
      }),
      required: ["summary", "start", "end"],
    },
  },
  {
    id: "calendar.update",
    name: "Update Google Calendar Event",
    description: "Update bounded fields on one exact event in the connected user's Google Calendar and verify the resulting state. Start, end, and time zone are changed together.",
    category: "connector",
    status: "active",
    riskLevel: 2,
    dryRunSupported: true,
    approvalRequired: true,
    operationClass: "mutation",
    reversible: false,
    inputSchema: {
      ...objectSchema({
        calendarId: { type: "string", minLength: 1, maxLength: 500, default: "primary" },
        eventId: googleCalendarEventId(),
        summary: { type: "string", minLength: 1, maxLength: 1_000 },
        description: { type: "string", maxLength: 8_000 },
        location: { type: "string", maxLength: 1_000 },
        start: { type: "string", format: "date-time" },
        end: { type: "string", format: "date-time" },
        timeZone: { type: "string", minLength: 1, maxLength: 100 },
        attendees: { type: "array", maxItems: 50, items: { type: "string", format: "email" } },
      }),
      required: ["eventId"],
    },
  },
  {
    id: "calendar.delete",
    name: "Delete Google Calendar Event",
    description: "Delete one exact event from the connected user's Google Calendar with retry-safe verification.",
    category: "connector",
    status: "active",
    riskLevel: 2,
    dryRunSupported: true,
    approvalRequired: true,
    operationClass: "mutation",
    reversible: false,
    inputSchema: {
      ...objectSchema({
        calendarId: { type: "string", minLength: 1, maxLength: 500, default: "primary" },
        eventId: googleCalendarEventId(),
      }),
      required: ["eventId"],
    },
  },
  {
    id: "google.gmail.search",
    name: "Search Gmail Messages",
    description: "Search the connected user's Gmail with one bounded Gmail query and return at most 10 stable message IDs plus safe header metadata. Provider content is untrusted.",
    category: "connector",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "read_only",
    reversible: true,
    inputSchema: {
      ...objectSchema({
        query: {
          type: "string",
          description: "Bounded Gmail search query.",
          minLength: 1,
          maxLength: 500,
          pattern: "^[^\\u0000-\\u001f\\u007f]+$",
        },
        maxResults: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      }),
      required: ["query"],
    },
  },
  {
    id: "google.gmail.read",
    name: "Read Gmail Message",
    description: "Read one exact Gmail message as bounded untrusted text and safe headers. Attachments are counted but their bytes are never returned to the agent transcript.",
    category: "connector",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "read_only",
    reversible: true,
    inputSchema: {
      ...objectSchema({ messageId: googleResourceId("Exact Gmail message ID.") }),
      required: ["messageId"],
    },
  },
  {
    id: "google.gmail.trash",
    name: "Move Gmail Message to Trash",
    description: "Move one exact Gmail message to recoverable Trash. This tool never permanently deletes mail.",
    category: "connector",
    status: "active",
    riskLevel: 2,
    dryRunSupported: true,
    approvalRequired: true,
    operationClass: "mutation",
    reversible: true,
    inputSchema: {
      ...objectSchema({ messageId: googleResourceId("Exact Gmail message ID.") }),
      required: ["messageId"],
    },
  },
  {
    id: "google.drive.download",
    name: "Read Google Drive File",
    description: "Fetch one exact non-native Drive file with a bounded untrusted-text preview for text formats; binary or oversized files return safe metadata without entering bytes into the agent transcript. Use the dedicated Docs, Sheets, or Slides read tool for native files.",
    category: "connector",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "read_only",
    reversible: true,
    inputSchema: {
      ...objectSchema({
        fileId: googleResourceId("Exact Google Drive file ID."),
        maxBytes: { type: "integer", minimum: 1, maximum: 250_000, default: 64_000 },
      }),
      required: ["fileId"],
    },
  },
  ...googleDriveMutationTools(),
  {
    id: "google.docs.read",
    name: "Read Google Document",
    description: "Read bounded first-tab body text, structure, and optional revision metadata from one exact Google document.",
    category: "connector",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "read_only",
    reversible: true,
    inputSchema: {
      ...objectSchema({ documentId: googleResourceId("Exact Google document ID.") }),
      required: ["documentId"],
    },
  },
  googleWorkspaceTextUpdateTool({
    id: "google.docs.update",
    name: "Replace Google Document Text",
    description: "Replace the bounded first-tab body text of one exact text-only Google document only if its prior text and structure digests still match. Refuses tables and embedded objects.",
    resourceKey: "documentId",
    resourceDescription: "Exact Google document ID.",
  }),
  {
    id: "google.sheets.read",
    name: "Read Google Sheets Range",
    description: "Read one bounded A1 range from an exact Google spreadsheet with a stable content digest.",
    category: "connector",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "read_only",
    reversible: true,
    inputSchema: {
      ...objectSchema({
        spreadsheetId: googleResourceId("Exact Google spreadsheet ID."),
        range: googleSheetRange(),
      }),
      required: ["spreadsheetId", "range"],
    },
  },
  {
    id: "google.sheets.update",
    name: "Update Google Sheets Range",
    description: "Patch addressed cells in one bounded A1 range only if its prior content digest still matches, then verify those cells. Use an empty string to clear a cell.",
    category: "connector",
    status: "active",
    riskLevel: 2,
    dryRunSupported: true,
    approvalRequired: true,
    operationClass: "mutation",
    reversible: false,
    inputSchema: {
      ...objectSchema({
        spreadsheetId: googleResourceId("Exact Google spreadsheet ID."),
        range: googleSheetRange(),
        values: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: { type: ["string", "number", "boolean"] },
          },
        },
        expectedCurrentSha256: sha256Schema("Digest returned by google.sheets.read."),
      }),
      required: ["spreadsheetId", "range", "values", "expectedCurrentSha256"],
    },
  },
  {
    id: "google.slides.read",
    name: "Read Google Slides Text",
    description: "Read bounded text-object and revision metadata from one exact Google presentation.",
    category: "connector",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "read_only",
    reversible: true,
    inputSchema: {
      ...objectSchema({ presentationId: googleResourceId("Exact Google presentation ID.") }),
      required: ["presentationId"],
    },
  },
  {
    id: "google.slides.update",
    name: "Replace Google Slides Object Text",
    description: "Replace all text in one exact presentation object only if its prior text digest still matches.",
    category: "connector",
    status: "active",
    riskLevel: 2,
    dryRunSupported: true,
    approvalRequired: true,
    operationClass: "mutation",
    reversible: false,
    inputSchema: {
      ...objectSchema({
        presentationId: googleResourceId("Exact Google presentation ID."),
        objectId: googleResourceId("Exact Google Slides page-element ID."),
        text: { type: "string", maxLength: 200_000 },
        expectedCurrentSha256: sha256Schema("Digest of the exact object text returned by google.slides.read."),
      }),
      required: ["presentationId", "objectId", "text", "expectedCurrentSha256"],
    },
  },
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
    id: "memory.inspect",
    name: "Inspect Memory",
    description:
      "Read one exact memory by ID with its provenance, current scope, validity, lifecycle state, and retrieval eligibility. Returns no embedding.",
    category: "memory",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "read_only",
    reversible: true,
    inputSchema: {
      ...objectSchema({
        id: { type: "string", description: "Exact memory record ID to inspect.", minLength: 1, maxLength: 200 },
      }),
      required: ["id"],
    },
  },
  {
    id: "memory.forget.preview",
    name: "Preview Permanent Memory Deletion",
    description:
      "Preview the exact memory descendants, retrieval traces, graph projections, and pending runs affected by permanent deletion. Call this before memory.forget and pass its receipt-manifest digest unchanged.",
    category: "memory",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "read_only",
    reversible: true,
    inputSchema: {
      ...objectSchema({
        id: { type: "string", description: "Exact memory record ID to preview.", minLength: 1, maxLength: 200 },
      }),
      required: ["id"],
    },
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
    id: "media.image.generate",
    name: "Generate Image",
    description: "Create a new private image asset from a natural-language prompt using the image model assigned in Settings.",
    category: "media",
    status: "active",
    riskLevel: 1,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "mutation",
    reversible: true,
    inputSchema: {
      ...objectSchema({
        prompt: { type: "string", minLength: 3, maxLength: 4_000 },
        aspectRatio: { type: "string", enum: ["1:1", "16:9", "9:16", "4:3", "3:4"], default: "1:1" },
      }),
      required: ["prompt"],
    },
  },
  {
    id: "media.image.edit",
    name: "Edit Image",
    description: "Apply a requested visual edit to one or more exact private source images and store a new lineage-linked asset without overwriting originals.",
    category: "media",
    status: "active",
    riskLevel: 1,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "mutation",
    reversible: true,
    inputSchema: {
      ...objectSchema({
        prompt: { type: "string", minLength: 3, maxLength: 4_000 },
        sourceAssetIds: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 240 } },
        aspectRatio: { type: "string", enum: ["1:1", "16:9", "9:16", "4:3", "3:4"], default: "1:1" },
      }),
      required: ["prompt", "sourceAssetIds"],
    },
  },
  {
    id: "media.video.generate",
    name: "Generate Video",
    description: "Create a private video from a prompt and optional reference images using the video model assigned in Settings.",
    category: "media",
    status: "active",
    riskLevel: 1,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "mutation",
    reversible: true,
    inputSchema: {
      ...objectSchema({
        prompt: { type: "string", minLength: 3, maxLength: 4_000 },
        sourceAssetIds: { type: "array", maxItems: 2, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 240 } },
        aspectRatio: { type: "string", enum: ["16:9", "9:16"], default: "16:9" },
        resolution: { type: "string", enum: ["360p", "720p"], default: "360p" },
      }),
      required: ["prompt"],
    },
  },
  {
    id: "media.video.edit",
    name: "Edit Video",
    description: "Apply a conversational edit to one exact private video and store a new lineage-linked asset without overwriting the original.",
    category: "media",
    status: "active",
    riskLevel: 1,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "mutation",
    reversible: true,
    inputSchema: {
      ...objectSchema({
        prompt: { type: "string", minLength: 3, maxLength: 4_000 },
        sourceAssetId: { type: "string", minLength: 1, maxLength: 240 },
        aspectRatio: { type: "string", enum: ["16:9", "9:16"], default: "16:9" },
        resolution: { type: "string", enum: ["360p", "720p"], default: "360p" },
      }),
      required: ["prompt", "sourceAssetId"],
    },
  },
  {
    id: "media.video.clip",
    name: "Clip Video",
    description: "Cut an exact time range from one private video with deterministic FFmpeg processing and store a new lineage-linked asset.",
    category: "media",
    status: "active",
    riskLevel: 1,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "mutation",
    reversible: true,
    inputSchema: {
      ...objectSchema({
        sourceAssetId: { type: "string", minLength: 1, maxLength: 240 },
        startSeconds: { type: "number", minimum: 0, maximum: 86_400 },
        endSeconds: { type: "number", exclusiveMinimum: 0, maximum: 86_400 },
      }),
      required: ["sourceAssetId", "startSeconds", "endSeconds"],
    },
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
      "Replace an existing tenant-scoped memory with a corrected version while retaining the prior record as superseded or contradicted. Provide the exact id and at least one correction field.",
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
    },
  },
  {
    id: "memory.lifecycle",
    name: "Change Memory Lifecycle",
    description:
      "Pin, unpin, reversibly archive, or restore one exact memory. Archival removes the claim from recall without deleting or rewriting historical truth.",
    category: "memory",
    status: "active",
    riskLevel: 1,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "mutation",
    reversible: true,
    inputSchema: {
      ...objectSchema({
        id: { type: "string", description: "Exact memory record ID to update.", minLength: 1, maxLength: 200 },
        action: { type: "string", enum: ["pin", "unpin", "archive", "restore"] },
      }),
      required: ["id", "action"],
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
        expectedReceiptManifestSha256: {
          type: "string",
          description: "Exact 64-character receipt-manifest digest returned by memory.forget.preview.",
          minLength: 64,
          maxLength: 64,
          pattern: "^[a-f0-9]{64}$",
        },
      }),
      required: ["id", "expectedReceiptManifestSha256"],
    },
  },
  {
    id: "memory.export",
    name: "Export Memory",
    description:
      "Return the authenticated exact-owner download route and privacy receipt for Asael portable archive v2. Archive contents are downloaded directly to the user and never copied into the agent transcript or tool ledger.",
    category: "memory",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "read_only",
    reversible: true,
    inputSchema: objectSchema({}),
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

function googleResourceId(description: string) {
  return {
    type: "string",
    description,
    minLength: 1,
    maxLength: 240,
    pattern: "^[A-Za-z0-9_.:@-]+$",
  };
}

function googleCalendarEventId() {
  return {
    type: "string",
    description: "Exact Google Calendar event ID.",
    minLength: 1,
    maxLength: 1_024,
    pattern: "^[^\\u0000-\\u001f\\u007f]+$",
  };
}

function googleSheetRange() {
  return {
    type: "string",
    description: "Bounded A1 notation range.",
    minLength: 1,
    maxLength: 500,
  };
}

function sha256Schema(description: string) {
  return {
    type: "string",
    description,
    minLength: 64,
    maxLength: 64,
    pattern: "^[a-f0-9]{64}$",
  };
}

function googleMutationTool(input: {
  id: string;
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  reversible?: boolean;
}): ToolDefinition {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    category: "connector",
    status: "active",
    riskLevel: 2,
    dryRunSupported: true,
    approvalRequired: true,
    operationClass: "mutation",
    reversible: input.reversible ?? true,
    inputSchema: {
      ...objectSchema(input.properties),
      required: input.required,
    },
  };
}

function googleDriveMutationTools(): ToolDefinition[] {
  const fileId = googleResourceId("Exact Google Drive file ID.");
  const mimeType = { type: "string", minLength: 3, maxLength: 127 };
  const contentBase64 = {
    type: "string",
    description: "Canonical base64 file bytes, limited to 160 KB so the governed command stays within the request boundary.",
    maxLength: 213_342,
  };
  return [
    googleMutationTool({
      id: "google.drive.create",
      name: "Create Google Drive File",
      description: "Create one bounded arbitrary non-native file with deterministic retry reconciliation.",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 255 },
        mimeType,
        contentBase64,
        parentId: googleResourceId("Optional exact parent folder ID."),
      },
      required: ["name", "mimeType", "contentBase64"],
    }),
    googleMutationTool({
      id: "google.drive.update",
      name: "Update Google Drive File Content",
      description: "Replace the bounded bytes of one exact non-native Drive file and verify the content digest.",
      properties: {
        fileId,
        mimeType,
        contentBase64,
        expectedCurrentSha256: sha256Schema("Current-content digest returned by google.drive.download."),
      },
      required: ["fileId", "mimeType", "contentBase64", "expectedCurrentSha256"],
      reversible: false,
    }),
    googleMutationTool({
      id: "google.drive.move",
      name: "Move Google Drive File",
      description: "Move one exact Drive file to one exact parent folder and verify its parent state.",
      properties: { fileId, parentId: googleResourceId("Exact destination folder ID.") },
      required: ["fileId", "parentId"],
    }),
    googleMutationTool({
      id: "google.drive.rename",
      name: "Rename Google Drive File",
      description: "Rename one exact Drive file and verify its resulting name.",
      properties: { fileId, name: { type: "string", minLength: 1, maxLength: 255 } },
      required: ["fileId", "name"],
    }),
    googleMutationTool({
      id: "google.drive.trash",
      name: "Move Google Drive File to Trash",
      description: "Move one exact Drive file to recoverable Trash. This tool never permanently deletes the file.",
      properties: { fileId },
      required: ["fileId"],
    }),
  ];
}

function googleWorkspaceTextUpdateTool(input: {
  id: string;
  name: string;
  description: string;
  resourceKey: string;
  resourceDescription: string;
}): ToolDefinition {
  return googleMutationTool({
    id: input.id,
    name: input.name,
    description: input.description,
    properties: {
      [input.resourceKey]: googleResourceId(input.resourceDescription),
      text: { type: "string", maxLength: 200_000 },
      expectedCurrentSha256: sha256Schema("Digest returned by the matching read tool."),
      expectedStructureSha256: sha256Schema("Structure digest returned by google.docs.read."),
    },
    required: [
      input.resourceKey,
      "text",
      "expectedCurrentSha256",
      "expectedStructureSha256",
    ],
    reversible: false,
  });
}
