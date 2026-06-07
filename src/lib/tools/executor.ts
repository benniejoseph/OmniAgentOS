import { z } from "zod";
import { embedTexts } from "@/lib/openai/client";
import { getMcpGovernedTool, getOpenApiGovernedTool } from "@/lib/connectors/governed-tools";
import { callMcpTool } from "@/lib/connectors/mcp-client";
import { callOpenApiOperation } from "@/lib/connectors/openapi-client";
import { getOpenApiConnector, getOpenApiOperationById } from "@/lib/connectors/openapi-store";
import { getMcpConnector, getMcpToolById } from "@/lib/connectors/store";
import { saveMemory, searchMemories } from "@/lib/memory/store";
import type { MemoryType } from "@/lib/memory/types";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { searchKnowledge } from "@/lib/rag/store";
import { listAgentRuns } from "@/lib/runs/store";
import { createToolExecutionRecord, saveToolExecution } from "@/lib/tools/audit-store";
import { evaluateToolPolicy } from "@/lib/tools/policy";
import type { SecurityContext } from "@/lib/security/types";
import { getGovernedTool } from "@/lib/tools/registry";
import type { ToolDefinition, ToolExecutionRecord } from "@/lib/tools/types";

const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
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
    (await getMcpGovernedTool(toolId)) ||
    (await getOpenApiGovernedTool(toolId));
  if (!tool) {
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
      reason: "Unknown tools are blocked by default.",
    });
    return {
      record: await saveToolExecution(record),
      result: null,
    };
  }

  const decision = evaluateToolPolicy({ tool, approved });
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
    return { record: await saveToolExecution(record), result: null };
  }

  if (decision.approvalRequired && !decision.allowed && !dryRun) {
    const record = createRecord({
      ...baseRecord,
      status: "approval_required" as const,
    });
    return { record: await saveToolExecution(record), result: null };
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
    return { record: await saveToolExecution(record), result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed.";
    const record = createRecord({
      ...baseRecord,
      status: "failed" as const,
      output: { error: message },
      reason: message,
      completedAt: new Date().toISOString(),
    });
    return { record: await saveToolExecution(record), result: null };
  }
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
      runs: await listAgentRuns(limit || 5),
    };
  }

  if (tool.category === "mcp") {
    const mcpTool = await getMcpToolById(tool.id);
    if (!mcpTool) {
      throw new Error(`MCP tool ${tool.id} is not registered.`);
    }

    const connector = await getMcpConnector(mcpTool.connectorId);
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
    const operation = await getOpenApiOperationById(tool.id);
    if (!operation) {
      throw new Error(`OpenAPI operation ${tool.id} is not registered.`);
    }

    const connector = await getOpenApiConnector(operation.connectorId);
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

  if (tool.id === "memory.write") {
    return memoryWriteSchema.parse(input);
  }

  if (tool.id === "knowledge.ingest") {
    return knowledgeIngestSchema.parse(input);
  }

  if (tool.id === "runs.list") {
    return runsListSchema.parse(input);
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

  if (toolId.startsWith("mcp:")) {
    return ["remote MCP tool call", "side effects depend on discovered tool annotations and connector policy"];
  }

  if (toolId.startsWith("openapi:")) {
    return ["remote REST API call", "side effects depend on HTTP method, endpoint, and connector policy"];
  }

  return ["read-only"];
}
