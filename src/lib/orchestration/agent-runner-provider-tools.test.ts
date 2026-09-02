import { describe, expect, it, vi } from "vitest";
import {
  runNonOpenAIProviderToolLoop,
} from "@/lib/orchestration/agent-runner";
import type { AgentEvent } from "@/lib/orchestration/types";
import type {
  ModelToolCall,
  ModelToolTurnRequest,
  ModelToolTurnResult,
} from "@/lib/models/types";
import type { ToolDefinition, ToolExecutionRecord } from "@/lib/tools/types";

describe("non-OpenAI governed provider tool loop", () => {
  it("executes safe calls through governance and aggregates every model turn", async () => {
    const firstCalls: ModelToolCall[] = [
      { callId: "call-1", name: "memory_search", argumentsJson: "{\"query\":\"Ada\"}" },
      { callId: "call-2", name: "knowledge_search", argumentsJson: "{\"query\":\"Lovelace\"}" },
    ];
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      if (!request.toolResults) {
        return turn({ toolCalls: firstCalls, inputTokens: 10, outputTokens: 2, cost: 0.001 });
      }
      expect(request.preferredProvider).toBe("google");
      expect(request.allowedProviders).toEqual(["google"]);
      expect(request.allowCrossProviderFallback).toBe(false);
      expect(request.toolResults).toHaveLength(2);
      return turn({ text: "Ada Lovelace found.", inputTokens: 12, outputTokens: 4, cost: 0.002 });
    });
    const executeTool = vi.fn(async (request: { toolId: string }) => ({
      record: executionRecord(request.toolId, "executed"),
      result: { matches: [request.toolId] },
    }));

    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use tools when needed.",
      prompt: "Find Ada Lovelace",
      tools: [modelTool("memory_search"), modelTool("knowledge_search")],
      toolbox: {
        byFunctionName: new Map([
          ["memory_search", { definition: toolDefinition("memory.search"), functionName: "memory_search" }],
          ["knowledge_search", { definition: toolDefinition("knowledge.search"), functionName: "knowledge_search" }],
        ]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-1",
      generateTurn,
      executeTool: executeTool as never,
    });
    const collected = await collect(loop);

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(collected.events.filter((event) => event.type === "tool").map((event) => event.status)).toEqual([
      "running",
      "running",
      "executed",
      "executed",
    ]);
    expect(collected.result).toMatchObject({
      text: "Ada Lovelace found.",
      provider: "google",
      turns: 2,
      latencyMs: 20,
      usage: { inputTokens: 22, outputTokens: 6, totalTokens: 28 },
      estimatedCostUsd: 0.003,
      costKnown: true,
    });
    expect(collected.result.attempts).toHaveLength(2);
  });

  it("parks approval-required calls without advancing the provider turn", async () => {
    const generateTurn = vi.fn(async () => turn({
      toolCalls: [{ callId: "call-approval", name: "http_request", argumentsJson: "{\"url\":\"https://example.com\"}" }],
    }));
    const definition = toolDefinition("http.request", {
      name: "HTTP Request",
      riskLevel: 2,
      approvalRequired: true,
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use tools when needed.",
      prompt: "Call the endpoint",
      tools: [modelTool("http_request")],
      toolbox: {
        byFunctionName: new Map([["http_request", { definition, functionName: "http_request" }]]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-approval",
      generateTurn,
      executeTool: vi.fn(async () => ({
        record: executionRecord("http.request", "approval_required", {
          name: "HTTP Request",
          riskLevel: 2,
          approvalRequired: true,
          reason: "Human approval required.",
        }),
      })) as never,
    });
    const collected = await collect(loop);

    expect(collected.events).toContainEqual(expect.objectContaining({
      type: "tool",
      status: "approval_required",
    }));
    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(collected.result.text).toBe("");
    expect(collected.result.waitingApproval).toMatchObject({
      executionId: "execution-http.request",
      toolId: "http.request",
      toolName: "HTTP Request",
      providerState: {
        provider: "google",
        pendingCall: { callId: "call-approval", name: "http_request" },
        toolResultsBeforeApproval: [],
      },
    });
  });
});

function turn(input: {
  text?: string;
  toolCalls?: ModelToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}): ModelToolTurnResult {
  const inputTokens = input.inputTokens || 0;
  const outputTokens = input.outputTokens || 0;
  return {
    text: input.text || "",
    toolCalls: input.toolCalls || [],
    continuation: { provider: "google", state: [] },
    provider: "google",
    model: "gemini-test",
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      totalTokens: inputTokens + outputTokens,
    },
    latencyMs: 10,
    ...(input.cost === undefined ? {} : { estimatedCostUsd: input.cost }),
    costKnown: input.cost !== undefined,
    attempts: [{
      provider: "google",
      model: "gemini-test",
      status: "completed",
      latencyMs: 10,
    }],
  };
}

function modelTool(name: string) {
  return {
    type: "function" as const,
    name,
    description: `Run ${name}`,
    parameters: { type: "object" },
  };
}

function toolDefinition(
  id: string,
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    category: "memory",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    reversible: true,
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function executionRecord(
  toolId: string,
  status: ToolExecutionRecord["status"],
  overrides: {
    name?: string;
    riskLevel?: ToolExecutionRecord["riskLevel"];
    approvalRequired?: boolean;
    reason?: string;
  } = {},
): ToolExecutionRecord {
  return {
    id: `execution-${toolId}`,
    toolId,
    toolName: overrides.name || toolId,
    riskLevel: overrides.riskLevel || 0,
    status,
    dryRun: false,
    approvalRequired: overrides.approvalRequired || false,
    input: {},
    reason: overrides.reason,
    createdAt: new Date(0).toISOString(),
  };
}

async function collect(
  generator: ReturnType<typeof runNonOpenAIProviderToolLoop>,
) {
  const events: AgentEvent[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}
