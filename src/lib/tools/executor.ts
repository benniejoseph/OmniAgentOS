import { z } from "zod";
import { embedTexts } from "@/lib/openai/client";
import { saveMemory, searchMemories } from "@/lib/memory/store";
import type { MemoryType } from "@/lib/memory/types";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { searchKnowledge } from "@/lib/rag/store";
import { listAgentRuns } from "@/lib/runs/store";
import { createToolExecutionRecord, saveToolExecution } from "@/lib/tools/audit-store";
import { evaluateToolPolicy } from "@/lib/tools/policy";
import { getGovernedTool } from "@/lib/tools/registry";
import type { ToolDefinition } from "@/lib/tools/types";

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
}: {
  toolId: string;
  input: Record<string, unknown>;
  dryRun?: boolean;
  approved?: boolean;
}) {
  const tool = getGovernedTool(toolId);
  if (!tool) {
    const record = createToolExecutionRecord({
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
    toolId: tool.id,
    toolName: tool.name,
    riskLevel: decision.riskLevel,
    dryRun,
    approvalRequired: decision.approvalRequired,
    input,
    reason: decision.reason,
  };

  if (decision.blocked) {
    const record = createToolExecutionRecord({
      ...baseRecord,
      status: "blocked" as const,
    });
    return { record: await saveToolExecution(record), result: null };
  }

  if (decision.approvalRequired && !decision.allowed && !dryRun) {
    const record = createToolExecutionRecord({
      ...baseRecord,
      status: "approval_required" as const,
    });
    return { record: await saveToolExecution(record), result: null };
  }

  try {
    if (dryRun) {
      const preview = dryRunTool(tool, input);
      const record = createToolExecutionRecord({
        ...baseRecord,
        status: "dry_run" as const,
        output: preview,
        completedAt: new Date().toISOString(),
      });
      return { record: await saveToolExecution(record), result: preview };
    }

    const result = await runTool(tool, input);
    const record = createToolExecutionRecord({
      ...baseRecord,
      status: "executed" as const,
      output: result,
      completedAt: new Date().toISOString(),
    });
    return { record: await saveToolExecution(record), result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed.";
    const record = createToolExecutionRecord({
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

async function runTool(tool: ToolDefinition, input: Record<string, unknown>) {
  const parsed = parseInput(tool, input);

  if (tool.id === "memory.search") {
    const { query, limit } = searchSchema.parse(parsed);
    const queryEmbedding = (await embedTexts([query]))?.[0];
    const results = await searchMemories(query, { limit: limit || 5, queryEmbedding });
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
    const results = await searchKnowledge(query, { limit: limit || 5, queryEmbedding });
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

  return input;
}

function describeSideEffects(toolId: string) {
  if (toolId === "memory.write") {
    return ["writes omni_memories", "may create embedding"];
  }

  if (toolId === "knowledge.ingest") {
    return ["writes omni_knowledge_documents", "writes omni_knowledge_chunks", "writes compatible memory records"];
  }

  return ["read-only"];
}
