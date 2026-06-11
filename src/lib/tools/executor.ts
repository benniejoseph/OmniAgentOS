import { z } from "zod";
import { embedTexts } from "@/lib/openai/client";
import { getMcpGovernedTool, getOpenApiGovernedTool } from "@/lib/connectors/governed-tools";
import { callMcpTool } from "@/lib/connectors/mcp-client";
import { callOpenApiOperation } from "@/lib/connectors/openapi-client";
import { getOpenApiConnector, getOpenApiOperationById } from "@/lib/connectors/openapi-store";
import { getMcpConnector, getMcpToolById } from "@/lib/connectors/store";
import { saveMemory, searchMemories } from "@/lib/memory/store";
import type { MemoryType } from "@/lib/memory/types";
import { recordRuntimeEventSafely } from "@/lib/observability/store";
import { validateConnectorSecretEnvName } from "@/lib/security/context";
import { assertPublicHttpUrl } from "@/lib/security/network";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { searchKnowledge } from "@/lib/rag/store";
import { listAgentRuns } from "@/lib/runs/store";
import { createToolExecutionRecord, saveToolExecution } from "@/lib/tools/audit-store";
import { evaluateToolPolicy } from "@/lib/tools/policy";
import type { SecurityContext } from "@/lib/security/types";
import { getGovernedTool } from "@/lib/tools/registry";
import { RISK3_QUORUM, type ToolDefinition, type ToolExecutionRecord } from "@/lib/tools/types";
import { actionClassFor, recordActionOutcome, resolveAutonomy } from "@/lib/trust/ledger";
import { isGraduatedAutonomyEnabled } from "@/lib/trust/policy";
import { runLiveWebSearch } from "@/lib/web-search/search";

const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
});

const webSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
  searchContextSize: z.enum(["low", "medium", "high"]).optional(),
  allowedDomains: z.array(z.string().min(1)).max(20).optional(),
});

const memoryWriteSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  type: z.enum(["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"]).optional(),
  tags: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
});

const knowledgeIngestSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1).max(20000),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const runsListSchema = z.object({
  limit: z.number().int().min(1).max(25).optional(),
});

const httpRequestSchema = z.object({
  url: z.string().min(1).max(2048),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  headers: z.record(z.string(), z.string().max(4096)).optional(),
  body: z.string().max(100_000).optional(),
  authEnv: z.string().max(120).optional(),
});

const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const HTTP_RESPONSE_MAX_CHARS = 20_000;

export async function executeGovernedTool({
  toolId,
  input,
  dryRun = true,
  approved = false,
  context,
  existingRecord,
  approvalReason,
}: {
  toolId: string;
  input: Record<string, unknown>;
  dryRun?: boolean;
  approved?: boolean;
  context?: SecurityContext;
  existingRecord?: ToolExecutionRecord;
  approvalReason?: string;
}) {
  const tool =
    getGovernedTool(toolId) ||
    (await getMcpGovernedTool(toolId, { tenantId: context?.tenantId })) ||
    (await getOpenApiGovernedTool(toolId, { tenantId: context?.tenantId }));
  if (!tool) {
    const reason = "Unknown tools are blocked by default.";
    const record = createToolExecutionRecord({
      tenantId: context?.tenantId,
      actorId: context?.actorId,
      toolId,
      toolName: "Unknown tool",
      riskLevel: 3,
      status: "blocked",
      dryRun,
      approvalRequired: true,
      input,
      reason,
    });
    await recordToolPolicyBlock({
      context,
      toolId,
      reason,
      input,
      riskLevel: 3,
    });
    return {
      record: await saveToolExecution(record),
      result: null,
    };
  }

  // Risk-3 approval is only honored when the record itself carries quorum
  // evidence: RISK3_QUORUM distinct admin/system approvers, requester excluded.
  // Enforced here so no API caller can bypass it with a bare approved flag.
  const effectiveApproved =
    approved && (tool.riskLevel < 3 || hasRisk3Quorum(existingRecord));

  // Graduated autonomy: an action class that has earned trust (clean track
  // record, reversible, risk < 3) may auto-approve instead of gating. Opt-in
  // and conservative — resolveAutonomy re-checks reversibility and risk tier.
  const reversible = tool.reversible ?? false;
  let autonomy: Awaited<ReturnType<typeof resolveAutonomy>> | undefined;
  let autonomyApproved = false;
  if (!dryRun && !effectiveApproved && isGraduatedAutonomyEnabled() && tool.riskLevel < 3) {
    autonomy = await resolveAutonomy({
      toolId: tool.id,
      tenantId: normalizeTenantId(context?.tenantId),
      riskLevel: tool.riskLevel,
      reversible,
    });
    autonomyApproved = autonomy.mode === "auto_with_alert";
  }

  const decision = evaluateToolPolicy({ tool, approved: effectiveApproved || autonomyApproved });
  const baseRecord = {
    tenantId: existingRecord?.tenantId || context?.tenantId,
    actorId: existingRecord?.actorId || context?.actorId,
    toolId: tool.id,
    toolName: tool.name,
    riskLevel: decision.riskLevel,
    dryRun,
    approvalRequired: decision.approvalRequired,
    input,
    reason: decision.reason,
  };
  const createRecord = (patch: Omit<ToolExecutionRecord, "id" | "createdAt">) => {
    if (!existingRecord) {
      return createToolExecutionRecord(patch);
    }

    return {
      ...existingRecord,
      ...patch,
      id: existingRecord.id,
      createdAt: existingRecord.createdAt,
      input: existingRecord.input,
    };
  };

  if (decision.blocked) {
    const record = createRecord({
      ...baseRecord,
      status: "blocked" as const,
      completedAt: new Date().toISOString(),
    });
    await recordToolPolicyBlock({
      context,
      toolId: tool.id,
      toolName: tool.name,
      reason: decision.reason,
      input,
      riskLevel: decision.riskLevel,
    });
    return { record: await saveToolExecution(record), result: null };
  }

  if (decision.approvalRequired && !decision.allowed && !dryRun) {
    const record = createRecord({
      ...baseRecord,
      status: "approval_required" as const,
    });
    const saved = await saveToolExecution(record);
    await recordRuntimeEventSafely({
      level: "warn",
      category: "workflow",
      action: "tool.approval_pending",
      tenantId: context?.tenantId,
      actorId: context?.actorId,
      resourceType: "tool_execution",
      resourceId: saved.id,
      message: `${tool.name} is waiting for human approval.`,
      metadata: {
        toolId: tool.id,
        toolName: tool.name,
        riskLevel: tool.riskLevel,
      },
    });
    return { record: saved, result: null };
  }

  try {
    if (dryRun) {
      const preview = dryRunTool(tool, input);
      const record = createRecord({
        ...baseRecord,
        status: "dry_run" as const,
        output: preview,
        completedAt: new Date().toISOString(),
      });
      return { record: await saveToolExecution(record), result: preview };
    }

    const result = await runTool(tool, input, context);
    const record = createRecord({
      ...baseRecord,
      status: "executed" as const,
      output: result,
      approvalDecision: decision.approvalRequired ? "approved" as const : undefined,
      approvedBy: decision.approvalRequired ? context?.actorId : undefined,
      approvedAt: decision.approvalRequired ? new Date().toISOString() : undefined,
      approvalReason,
      completedAt: new Date().toISOString(),
    });
    const saved = await saveToolExecution(record);
    if (autonomyApproved) {
      await recordRuntimeEventSafely({
        level: "warn",
        category: "security",
        action: "autonomy.auto_approved",
        tenantId: context?.tenantId,
        actorId: context?.actorId,
        resourceType: "tool_execution",
        resourceId: saved.id,
        message: `${tool.name} executed on earned autonomy without a fresh human approval.`,
        metadata: {
          toolId: tool.id,
          toolName: tool.name,
          riskLevel: tool.riskLevel,
          autonomyReason: autonomy?.reason,
          cleanStreak: autonomy?.cleanStreak,
        },
      });
    }
    await recordTrustOutcomeSafely(tool, context, "success", effectiveApproved);
    return { record: saved, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed.";
    if (tool.category === "mcp" || tool.category === "openapi") {
      await recordRuntimeEventSafely({
        level: "error",
        category: "connector",
        action: tool.category === "mcp" ? "connector.mcp.tool_failed" : "connector.openapi.tool_failed",
        tenantId: context?.tenantId,
        actorId: context?.actorId,
        resourceType: "tool",
        resourceId: tool.id,
        message,
        metadata: {
          failureType: "connector_failure",
          toolName: tool.name,
          toolCategory: tool.category,
          riskLevel: tool.riskLevel,
        },
      });
    }
    const record = createRecord({
      ...baseRecord,
      status: "failed" as const,
      output: { error: message },
      reason: message,
      completedAt: new Date().toISOString(),
    });
    const saved = await saveToolExecution(record);
    await recordTrustOutcomeSafely(tool, context, "failure", effectiveApproved);
    return { record: saved, result: null };
  }
}

/**
 * Record a trust outcome for gateable tools only (the ones where autonomy can
 * ever matter). Never throws — trust accounting must not break execution.
 */
async function recordTrustOutcomeSafely(
  tool: ToolDefinition,
  context: SecurityContext | undefined,
  kind: "success" | "failure",
  humanApproved: boolean,
) {
  if (!tool.approvalRequired && tool.riskLevel < 2) {
    return;
  }
  try {
    await recordActionOutcome({
      actionClass: actionClassFor(tool.id),
      toolId: tool.id,
      tenantId: normalizeTenantId(context?.tenantId),
      kind,
      reversible: tool.reversible ?? false,
      riskLevel: tool.riskLevel,
      humanApproved,
    });
  } catch (error) {
    console.warn("Trust outcome write failed.", error instanceof Error ? error.message : error);
  }
}

function normalizeTenantId(value?: string) {
  return (value || process.env.OMNIAGENT_DEFAULT_TENANT || "default").trim() || "default";
}

function dryRunTool(tool: ToolDefinition, input: Record<string, unknown>) {
  const parsed = parseInput(tool, input);
  return {
    toolId: tool.id,
    toolName: tool.name,
    riskLevel: tool.riskLevel,
    wouldExecute: tool.status === "active",
    sideEffects: describeSideEffects(tool.id),
    normalizedInput: parsed,
  };
}

async function runTool(tool: ToolDefinition, input: Record<string, unknown>, context?: SecurityContext) {
  const parsed = parseInput(tool, input);

  if (tool.id === "memory.search") {
    const { query, limit } = searchSchema.parse(parsed);
    const queryEmbedding = (await embedTexts([query]))?.[0];
    const results = await searchMemories(query, { limit: limit || 5, queryEmbedding, tenantId: context?.tenantId });
    return {
      results: results.map((result) => ({
        score: result.score,
        reasons: result.reasons,
        record: {
          ...result.record,
          embedding: undefined,
        },
      })),
    };
  }

  if (tool.id === "knowledge.search") {
    const { query, limit } = searchSchema.parse(parsed);
    const queryEmbedding = (await embedTexts([query]))?.[0];
    const results = await searchKnowledge(query, { limit: limit || 5, queryEmbedding, tenantId: context?.tenantId });
    return {
      results: results.map((result) => ({
        score: result.score,
        vectorScore: result.vectorScore,
        lexicalScore: result.lexicalScore,
        reasons: result.reasons,
        chunk: {
          ...result.chunk,
          embedding: undefined,
        },
        document: result.document,
      })),
    };
  }

  if (tool.id === "web.search") {
    const { query, limit, searchContextSize, allowedDomains } = webSearchSchema.parse(parsed);
    return runLiveWebSearch({
      query,
      maxSources: limit || 8,
      contextSize: searchContextSize || "medium",
      allowedDomains,
    });
  }

  if (tool.id === "memory.write") {
    const value = memoryWriteSchema.parse(parsed);
    const contentForEmbedding = `${value.title}\n\n${value.content}`;
    const embedding = (await embedTexts([contentForEmbedding]))?.[0];
    return {
      record: stripEmbedding(await saveMemory({
        tenantId: context?.tenantId,
        title: value.title,
        content: value.content,
        type: value.type as MemoryType | undefined,
        tags: value.tags || ["tool-execution"],
        importance: value.importance ?? 0.5,
        source: "tool-executor",
        scope: "workspace",
        embedding,
      })),
    };
  }

  if (tool.id === "knowledge.ingest") {
    const value = knowledgeIngestSchema.parse(parsed);
    const result = await ingestTextDocument({
      tenantId: context?.tenantId,
      title: value.title,
      content: value.content,
      source: value.source || "tool-executor",
      sourceType: "manual",
      tags: value.tags || ["tool-execution"],
    });
    return {
      document: result.document,
      chunks: result.chunks.length,
      memories: result.memories.length,
    };
  }

  if (tool.id === "runs.list") {
    const { limit } = runsListSchema.parse(parsed);
    return {
      runs: await listAgentRuns(limit || 5, { tenantId: context?.tenantId }),
    };
  }

  if (tool.id === "http.request") {
    return runHttpRequestTool(httpRequestSchema.parse(parsed));
  }

  if (tool.category === "mcp") {
    const mcpTool = await getMcpToolById(tool.id, { tenantId: context?.tenantId });
    if (!mcpTool) {
      throw new Error(`MCP tool ${tool.id} is not registered.`);
    }

    const connector = await getMcpConnector(mcpTool.connectorId, { tenantId: context?.tenantId });
    if (!connector) {
      throw new Error(`MCP connector ${mcpTool.connectorId} is not registered.`);
    }

    if (connector.status !== "active" || mcpTool.status !== "active") {
      throw new Error("MCP connector or tool is not active.");
    }

    return {
      connector: {
        id: connector.id,
        name: connector.name,
        endpoint: connector.endpoint,
      },
      tool: {
        id: mcpTool.id,
        name: mcpTool.name,
        riskLevel: mcpTool.riskLevel,
      },
      result: await callMcpTool({
        connector,
        toolName: mcpTool.name,
        args: parsed,
      }),
    };
  }

  if (tool.category === "openapi") {
    const operation = await getOpenApiOperationById(tool.id, { tenantId: context?.tenantId });
    if (!operation) {
      throw new Error(`OpenAPI operation ${tool.id} is not registered.`);
    }

    const connector = await getOpenApiConnector(operation.connectorId, { tenantId: context?.tenantId });
    if (!connector) {
      throw new Error(`OpenAPI connector ${operation.connectorId} is not registered.`);
    }

    if (connector.status !== "active" || operation.status !== "active") {
      throw new Error("OpenAPI connector or operation is not active.");
    }

    return {
      connector: {
        id: connector.id,
        name: connector.name,
        baseUrl: connector.baseUrl,
      },
      operation: {
        id: operation.id,
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        riskLevel: operation.riskLevel,
      },
      result: await callOpenApiOperation({
        connector,
        operation,
        input: parsed,
      }),
    };
  }

  throw new Error(`No handler is registered for ${tool.id}.`);
}

async function recordToolPolicyBlock({
  context,
  toolId,
  toolName,
  reason,
  input,
  riskLevel,
}: {
  context?: SecurityContext;
  toolId: string;
  toolName?: string;
  reason: string;
  input: Record<string, unknown>;
  riskLevel: number;
}) {
  await recordRuntimeEventSafely({
    level: "warn",
    category: "security",
    action: "security.policy_blocked",
    tenantId: context?.tenantId,
    actorId: context?.actorId,
    resourceType: "tool",
    resourceId: toolId,
    message: reason,
    metadata: {
      failureType: "policy_block",
      requestedAction: "execute.tool",
      toolName,
      riskLevel,
      input,
    },
  });
}

export function hasRisk3Quorum(record?: ToolExecutionRecord) {
  if (!record?.approvals?.length) {
    return false;
  }
  const distinctAdmins = new Set(
    record.approvals
      .filter((approval) => (approval.role === "admin" || approval.role === "system") && approval.by !== record.actorId)
      .map((approval) => approval.by),
  );
  return distinctAdmins.size >= RISK3_QUORUM;
}

async function runHttpRequestTool(input: z.infer<typeof httpRequestSchema>) {
  const url = await assertPublicHttpUrl(input.url, "Request URL");

  const headers = new Headers();
  for (const [name, value] of Object.entries(input.headers || {})) {
    // Header values that look like pasted secrets are rejected; secrets must
    // arrive via authEnv so they never sit in the audit ledger input.
    if (/^(sk-|Bearer\s|eyJ)/i.test(value.trim())) {
      throw new Error(`Header ${name} looks like a pasted secret. Reference it via authEnv instead.`);
    }
    headers.set(name, value);
  }

  if (input.authEnv) {
    if (!validateConnectorSecretEnvName(input.authEnv)) {
      throw new Error("authEnv must be an OMNIAGENT_CONNECTOR_* env var or allowlisted secret name.");
    }
    const secret = process.env[input.authEnv.trim().toUpperCase()];
    if (!secret) {
      throw new Error(`Env var ${input.authEnv} is not set in this environment.`);
    }
    headers.set("authorization", `Bearer ${secret}`);
  }

  const method = input.method || "GET";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("HTTP request timed out.")), HTTP_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === "GET" ? undefined : input.body,
      redirect: "manual",
      signal: controller.signal,
    });
    const rawBody = await response.text();
    return {
      url,
      method,
      status: response.status,
      statusText: response.statusText,
      redirected: response.status >= 300 && response.status < 400,
      location: response.headers.get("location") || undefined,
      contentType: response.headers.get("content-type") || undefined,
      body: rawBody.length > HTTP_RESPONSE_MAX_CHARS ? `${rawBody.slice(0, HTTP_RESPONSE_MAX_CHARS)}… [truncated]` : rawBody,
    };
  } finally {
    clearTimeout(timer);
  }
}

function stripEmbedding<T extends { embedding?: number[] }>(value: T) {
  return {
    ...value,
    embedding: undefined,
  };
}

function parseInput(tool: ToolDefinition, input: Record<string, unknown>) {
  if (tool.id === "memory.search" || tool.id === "knowledge.search") {
    return searchSchema.parse(input);
  }

  if (tool.id === "web.search") {
    return webSearchSchema.parse(input);
  }

  if (tool.id === "memory.write") {
    return memoryWriteSchema.parse(input);
  }

  if (tool.id === "knowledge.ingest") {
    return knowledgeIngestSchema.parse(input);
  }

  if (tool.id === "runs.list") {
    return runsListSchema.parse(input);
  }

  if (tool.id === "http.request") {
    return httpRequestSchema.parse(input);
  }

  if (tool.category === "mcp" || tool.category === "openapi") {
    return input;
  }

  return input;
}

function describeSideEffects(toolId: string) {
  if (toolId === "memory.write") {
    return ["writes omni_memories", "may create embedding"];
  }

  if (toolId === "knowledge.ingest") {
    return ["writes omni_knowledge_documents", "writes omni_knowledge_chunks", "writes compatible memory records"];
  }

  if (toolId === "web.search") {
    return ["read-only live web search", "uses OpenAI Responses web_search hosted tool", "stores source metadata in the tool audit ledger"];
  }

  if (toolId === "http.request") {
    return [
      "outbound HTTP call to a public endpoint",
      "side effects depend on the target API and method",
      "SSRF-guarded; redirects are not followed; response is truncated in the audit record",
    ];
  }

  if (toolId.startsWith("mcp:")) {
    return ["remote MCP tool call", "side effects depend on discovered tool annotations and connector policy"];
  }

  if (toolId.startsWith("openapi:")) {
    return ["remote REST API call", "side effects depend on HTTP method, endpoint, and connector policy"];
  }

  return ["read-only"];
}
