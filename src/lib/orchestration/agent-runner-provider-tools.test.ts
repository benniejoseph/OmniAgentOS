import { describe, expect, it, vi } from "vitest";
import {
  runNonOpenAIProviderToolLoop,
} from "@/lib/orchestration/agent-runner";
import { DYNAMIC_DELEGATION_CHILD_BUDGET } from "@/lib/delegation/runtime-policy";
import type { AgentEvent } from "@/lib/orchestration/types";
import type {
  ModelToolCall,
  ModelToolTurnRequest,
  ModelToolTurnResult,
} from "@/lib/models/types";
import type { ToolDefinition, ToolExecutionRecord } from "@/lib/tools/types";

describe("non-OpenAI governed provider tool loop", () => {
  it("keeps a third bounded turn for synthesis after two sequential read rounds", async () => {
    let turnIndex = 0;
    const generateTurn = vi.fn(async () => {
      turnIndex += 1;
      if (turnIndex === 1) {
        return turn({
          toolCalls: [{
            callId: "call-read-a",
            name: "read_a",
            argumentsJson: "{}",
          }],
        });
      }
      if (turnIndex === 2) {
        return turn({
          toolCalls: [{
            callId: "call-read-b",
            name: "read_b",
            argumentsJson: "{}",
          }],
        });
      }
      return turn({ text: "Bounded synthesis complete." });
    });
    const executeTool = vi.fn(async (request: { toolId: string }) => ({
      record: executionRecord(request.toolId, "executed"),
      result: { source: request.toolId },
    }));
    const beforeModelTurn = vi.fn(async (input: { attempt: number }) => {
      if (input.attempt > DYNAMIC_DELEGATION_CHILD_BUDGET.modelTurns) {
        throw new Error("Delegated child model-turn budget exceeded.");
      }
      return { maxAttempts: 1 };
    });

    const collected = await collect(runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Use both granted reads, then synthesize.",
      prompt: "Inspect both sources.",
      tools: [modelTool("read_a"), modelTool("read_b")],
      toolbox: {
        byFunctionName: new Map([
          ["read_a", { definition: toolDefinition("read.a"), functionName: "read_a" }],
          ["read_b", { definition: toolDefinition("read.b"), functionName: "read_b" }],
        ]),
      },
      securityContext: {
        tenantId: "tenant-child",
        actorId: "owner",
        role: "operator",
        source: "default",
      },
      runId: "run-child-three-turns",
      maxToolSteps: 2,
      beforeModelTurn: beforeModelTurn as never,
      generateTurn,
      executeTool: executeTool as never,
    }));

    expect(collected.result).toMatchObject({
      text: "Bounded synthesis complete.",
      turns: 3,
      toolSteps: 2,
    });
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(beforeModelTurn).toHaveBeenCalledTimes(3);
  });

  it("executes safe calls through governance and aggregates every model turn", async () => {
    const firstCalls: ModelToolCall[] = [
      { callId: "call-1", name: "memory_search", argumentsJson: "{\"query\":\"Ada\"}" },
      { callId: "call-2", name: "knowledge_search", argumentsJson: "{\"query\":\"Lovelace\"}" },
    ];
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      if (!request.toolResults) {
        expect(request.input).toBe("Find Ada Lovelace");
        expect(request.conversation).toEqual([
          { type: "message", role: "user", content: "Find Ada." },
          { type: "message", role: "assistant", content: "Which Ada?" },
          {
            type: "observation",
            source: "knowledge",
            content: "Ada Lovelace",
            untrusted: true,
          },
        ]);
        return turn({ toolCalls: firstCalls, inputTokens: 10, outputTokens: 2, cost: 0.001 });
      }
      expect(request.preferredProvider).toBe("google");
      expect(request.allowedProviders).toEqual(["google"]);
      expect(request.allowCrossProviderFallback).toBe(false);
      expect(request.toolResults).toHaveLength(2);
      expect(JSON.parse(request.toolResults![0].output)).toMatchObject({
        provenance: "tool_result",
        data: { executionId: "execution-memory.search" },
      });
      expect(JSON.parse(request.toolResults![1].output)).toMatchObject({
        provenance: "tool_result",
        data: {
          executionId: "execution-knowledge.search",
          admissibleEvidenceIds: ["knowledge:chunk-ada"],
        },
      });
      return turn({ text: "Ada Lovelace found.", inputTokens: 12, outputTokens: 4, cost: 0.002 });
    });
    const executeTool = vi.fn(async (request: { toolId: string }) => ({
      record: executionRecord(request.toolId, "executed"),
      result: request.toolId === "knowledge.search"
        ? {
            results: [{
              score: 0.98,
              chunk: {
                id: "chunk-ada",
                sourceRevisionId: "revision-ada",
                evidenceUnitId: "evidence-ada",
                title: "Ada Lovelace",
                content: "Ada Lovelace found.",
              },
            }],
          }
        : { matches: [request.toolId] },
    }));
    const beforeModelTurn = vi.fn(async (_input: {
      attempt: number;
      provider: "openai" | "google" | "anthropic" | "aws_bedrock";
      tier: "fast" | "reasoning";
    }) => ({ maxAttempts: 1 }));

    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use tools when needed.",
      prompt: "Find Ada Lovelace",
      conversation: [
        { type: "message", role: "user", content: "Find Ada." },
        { type: "message", role: "assistant", content: "Which Ada?" },
        {
          type: "observation",
          source: "knowledge",
          content: "Ada Lovelace",
          untrusted: true,
        },
      ],
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
      modelAttemptOffset: 4,
      beforeModelTurn,
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
    expect(collected.result.citationSources).toEqual([
      expect.objectContaining({
        citationId: "knowledge:chunk-ada",
        evidenceId: "chunk-ada",
        kind: "knowledge",
      }),
    ]);
    expect(generateTurn.mock.calls.every(([request]) => request.maxAttempts === 1))
      .toBe(true);
    expect(beforeModelTurn.mock.calls.map(([call]) => call)).toEqual([
      { attempt: 5, provider: "google", tier: "fast" },
      { attempt: 6, provider: "google", tier: "fast" },
    ]);
    expect(
      collected.events
        .filter((event) => event.type === "model")
        .map((event) => event.iteration),
    ).toEqual([5, 6]);
  });

  it("supplies the next provider turn with the governed local Mac observation", async () => {
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      if (!request.toolResults) {
        return turn({
          toolCalls: [{
            callId: "call-observe",
            name: "local_observe",
            argumentsJson: "{\"ref\":\"e7\"}",
          }],
        });
      }
      expect(request.toolResults).toEqual([expect.objectContaining({
        callId: "call-observe",
        output: expect.stringContaining("tool_result"),
        computerObservation: expect.objectContaining({
          executionId: "execution-local-observe",
          accessibilitySnapshot: expect.stringContaining("Success"),
          screenshot: expect.objectContaining({ mimeType: "image/webp" }),
        }),
      })]);
      return turn({ text: "The click succeeded; continue." });
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use what this Mac actually shows.",
      prompt: "Continue",
      tools: [modelTool("local_observe")],
      toolbox: {
        byFunctionName: new Map([["local_observe", {
          definition: toolDefinition("local.macos.observe"),
          functionName: "local_observe",
        }]]),
      },
      securityContext: {
        tenantId: "tenant-1",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-local-observe",
      generateTurn,
      executeTool: vi.fn(async () => ({
        record: executionRecord("local.macos.observe", "executed", {
          id: "execution-local-observe",
        }),
        result: { clicked: true },
        computerObservation: computerObservation(),
      })) as never,
    });

    const collected = await collect(loop);
    expect(collected.result.text).toBe("The click succeeded; continue.");
    expect(generateTurn).toHaveBeenCalledTimes(2);
  });

  it("carries a local Mac observation across exactly one sole app-list turn", async () => {
    let turnIndex = 0;
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      turnIndex += 1;
      if (turnIndex === 1) {
        expect(request.toolResults).toBeUndefined();
        return turn({
          toolCalls: [{
            callId: "call-observe",
            name: "local_observe",
            argumentsJson: "{}",
          }],
        });
      }
      if (turnIndex === 2) {
        expect(request.toolResults).toEqual([
          expect.objectContaining({
            callId: "call-observe",
            computerObservation: expect.objectContaining({
              source: "local_macos",
              snapshotRevision: "c".repeat(64),
            }),
          }),
        ]);
        return turn({
          toolCalls: [{
            callId: "call-list-once",
            name: "local_list_apps",
            argumentsJson: "{}",
          }],
        });
      }
      if (turnIndex === 3) {
        expect(request.toolResults).toEqual([
          expect.objectContaining({
            callId: "call-list-once",
            computerObservation: expect.objectContaining({
              source: "local_macos",
              executionId: "execution-local-observe",
            }),
          }),
        ]);
        return turn({
          toolCalls: [{
            callId: "call-list-twice",
            name: "local_list_apps",
            argumentsJson: "{}",
          }],
        });
      }
      expect(request.toolResults).toEqual([
        expect.not.objectContaining({ computerObservation: expect.anything() }),
      ]);
      return turn({ text: "The observation expired after one app-list hop." });
    });
    const executeTool = vi.fn(async (request: { toolId: string }) =>
      request.toolId === "local.macos.observe"
        ? {
            record: executionRecord(request.toolId, "executed", {
              id: "execution-local-observe",
            }),
            result: { summary: "Observed Finder." },
            computerObservation: localObservation(),
          }
        : {
            record: executionRecord(request.toolId, "executed"),
            result: { applications: ["Finder", "Chrome"] },
          }
    );
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Use fresh local evidence.",
      prompt: "Inspect this Mac.",
      tools: [modelTool("local_observe"), modelTool("local_list_apps")],
      toolbox: {
        byFunctionName: new Map([
          ["local_observe", {
            definition: toolDefinition("local.macos.observe"),
            functionName: "local_observe",
          }],
          ["local_list_apps", {
            definition: toolDefinition("local.macos.list_apps"),
            functionName: "local_list_apps",
          }],
        ]),
      },
      securityContext: {
        tenantId: "tenant-local",
        actorId: "owner-local",
        role: "admin",
        source: "default",
      },
      runId: "run-local-observation-hop",
      generateTurn,
      executeTool: executeTool as never,
    });

    const collected = await collect(loop);
    expect(collected.result.text).toBe(
      "The observation expired after one app-list hop.",
    );
    expect(generateTurn).toHaveBeenCalledTimes(4);
  });

  it("invalidates local Mac evidence after a state-changing action", async () => {
    let turnIndex = 0;
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      turnIndex += 1;
      if (turnIndex === 1) {
        return turn({
          toolCalls: [{
            callId: "call-observe",
            name: "local_observe",
            argumentsJson: "{}",
          }],
        });
      }
      if (turnIndex === 2) {
        expect(request.toolResults?.[0]?.computerObservation).toMatchObject({
          source: "local_macos",
        });
        return turn({
          toolCalls: [{
            callId: "call-activate",
            name: "local_activate_app",
            argumentsJson: "{\"bundleId\":\"com.google.Chrome\"}",
          }],
        });
      }
      expect(request.toolResults?.[0]).not.toHaveProperty(
        "computerObservation",
      );
      return turn({ text: "A fresh observation is required." });
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Observe after every state change.",
      prompt: "Open Chrome.",
      tools: [modelTool("local_observe"), modelTool("local_activate_app")],
      toolbox: {
        byFunctionName: new Map([
          ["local_observe", {
            definition: toolDefinition("local.macos.observe"),
            functionName: "local_observe",
          }],
          ["local_activate_app", {
            definition: toolDefinition("local.macos.activate_app"),
            functionName: "local_activate_app",
          }],
        ]),
      },
      securityContext: {
        tenantId: "tenant-local",
        actorId: "owner-local",
        role: "admin",
        source: "default",
      },
      runId: "run-local-observation-invalidated",
      generateTurn,
      executeTool: vi.fn(async (request: { toolId: string }) =>
        request.toolId === "local.macos.observe"
          ? {
              record: executionRecord(request.toolId, "executed", {
                id: "execution-local-observe",
              }),
              result: { summary: "Observed Finder." },
              computerObservation: localObservation(),
            }
          : {
              record: executionRecord(request.toolId, "executed"),
              result: { activated: true },
            }
      ) as never,
    });

    const collected = await collect(loop);
    expect(collected.result.text).toBe("A fresh observation is required.");
  });

  it("drops local Mac evidence before an approval continuation", async () => {
    let turnIndex = 0;
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      turnIndex += 1;
      if (turnIndex === 1) {
        return turn({
          toolCalls: [{
            callId: "call-observe",
            name: "local_observe",
            argumentsJson: "{}",
          }],
        });
      }
      expect(request.toolResults?.[0]?.computerObservation).toMatchObject({
        source: "local_macos",
      });
      return turn({
        toolCalls: [{
          callId: "call-approval",
          name: "local_press",
          argumentsJson: "{}",
        }],
      });
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Pause for consequential actions.",
      prompt: "Inspect then press.",
      tools: [modelTool("local_observe"), modelTool("local_press")],
      toolbox: {
        byFunctionName: new Map([
          ["local_observe", {
            definition: toolDefinition("local.macos.observe"),
            functionName: "local_observe",
          }],
          ["local_press", {
            definition: toolDefinition("local.macos.press", {
              riskLevel: 2,
              approvalRequired: true,
            }),
            functionName: "local_press",
          }],
        ]),
      },
      securityContext: {
        tenantId: "tenant-local",
        actorId: "owner-local",
        role: "admin",
        source: "default",
      },
      runId: "run-local-observation-approval",
      serializeToolCalls: true,
      generateTurn,
      executeTool: vi.fn(async (request: { toolId: string }) =>
        request.toolId === "local.macos.observe"
          ? {
              record: executionRecord(request.toolId, "executed", {
                id: "execution-local-observe",
              }),
              result: { summary: "Observed Finder." },
              computerObservation: localObservation(),
            }
          : {
              record: executionRecord(request.toolId, "approval_required"),
              result: null,
            }
      ) as never,
    });

    const collected = await collect(loop);
    expect(JSON.stringify(collected.result.waitingApproval)).not.toContain(
      "LOCAL_PRIVATE_SNAPSHOT",
    );
    expect(
      collected.result.waitingApproval?.providerState.toolResultsBeforeApproval,
    ).toEqual([]);
  });

  it("removes ephemeral computer evidence before parking provider state", async () => {
    const computerDefinition = toolDefinition("local.macos.observe");
    const approvalDefinition = toolDefinition("http.request", {
      riskLevel: 2,
      approvalRequired: true,
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use tools.",
      prompt: "Inspect then submit",
      tools: [modelTool("local_observe"), modelTool("http_request")],
      toolbox: {
        byFunctionName: new Map([
          ["local_observe", {
            definition: computerDefinition,
            functionName: "local_observe",
          }],
          ["http_request", {
            definition: approvalDefinition,
            functionName: "http_request",
          }],
        ]),
      },
      securityContext: {
        tenantId: "tenant-1",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-local-observe-approval",
      serializeToolCalls: true,
      generateTurn: vi.fn(async () => turn({
        toolCalls: [
          { callId: "call-observe", name: "local_observe", argumentsJson: "{}" },
          { callId: "call-approval", name: "http_request", argumentsJson: "{}" },
        ],
      })),
      executeTool: vi.fn(async (request: { toolId: string }) =>
        request.toolId === computerDefinition.id
          ? {
              record: executionRecord(request.toolId, "executed", {
                id: "execution-local-observe",
              }),
              result: { ok: true },
              computerObservation: computerObservation(),
            }
          : {
              record: executionRecord(request.toolId, "approval_required"),
              result: null,
            }
      ) as never,
    });

    const collected = await collect(loop);
    const parked = collected.result.waitingApproval?.providerState
      .toolResultsBeforeApproval[0];
    expect(parked?.output).toContain("tool_result");
    expect(parked).not.toHaveProperty("computerObservation");
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

  it("serializes otherwise parallel reads for a checkpoint chain", async () => {
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) =>
      request.toolResults
        ? turn({ text: "done" })
        : turn({
            toolCalls: [
              { callId: "call-a", name: "memory_search", argumentsJson: "{}" },
              { callId: "call-b", name: "knowledge_search", argumentsJson: "{}" },
            ],
          })
    );
    let activeExecutions = 0;
    let maximumActiveExecutions = 0;
    const executeTool = vi.fn(async (request: { toolId: string }) => {
      activeExecutions += 1;
      maximumActiveExecutions = Math.max(
        maximumActiveExecutions,
        activeExecutions,
      );
      await Promise.resolve();
      activeExecutions -= 1;
      return {
        record: executionRecord(request.toolId, "executed"),
        result: { ok: true },
      };
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use tools.",
      prompt: "Search both stores.",
      tools: [modelTool("memory_search"), modelTool("knowledge_search")],
      toolbox: {
        byFunctionName: new Map([
          ["memory_search", {
            definition: toolDefinition("memory.search"),
            functionName: "memory_search",
          }],
          ["knowledge_search", {
            definition: toolDefinition("knowledge.search"),
            functionName: "knowledge_search",
          }],
        ]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-serialized",
      serializeToolCalls: true,
      generateTurn,
      executeTool: executeTool as never,
    });

    await collect(loop);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(maximumActiveExecutions).toBe(1);
  });

  it("reserves the complete tool batch before starting any governed execution", async () => {
    const executeTool = vi.fn();
    const reserveTools = vi.fn(() => {
      throw new Error("Run tool-call budget is exhausted");
    });
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use tools.",
      prompt: "Search both stores.",
      tools: [modelTool("memory_search"), modelTool("knowledge_search")],
      toolbox: {
        byFunctionName: new Map([
          ["memory_search", {
            definition: toolDefinition("memory.search"),
            functionName: "memory_search",
          }],
          ["knowledge_search", {
            definition: toolDefinition("knowledge.search"),
            functionName: "knowledge_search",
          }],
        ]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-budgeted",
      reserveTools,
      generateTurn: vi.fn(async () => turn({
        toolCalls: [
          { callId: "call-a", name: "memory_search", argumentsJson: "{}" },
          { callId: "call-b", name: "knowledge_search", argumentsJson: "{}" },
        ],
      })),
      executeTool: executeTool as never,
    });

    await expect(collect(loop)).rejects.toThrow("tool-call budget");
    expect(reserveTools).toHaveBeenCalledWith([
      expect.objectContaining({ id: "memory.search" }),
      expect.objectContaining({ id: "knowledge.search" }),
    ]);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("uses a supplied local tool-step cap beyond the ordinary six-step boundary", async () => {
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      if (!request.toolResults) {
        expect(request.tools).toHaveLength(1);
        return turn({
          toolCalls: [{
            callId: "call-local-seven",
            name: "local_observe",
            argumentsJson: "{}",
          }],
        });
      }
      return turn({ text: "The seventh local round completed." });
    });
    const executeTool = vi.fn(async () => ({
      record: executionRecord("local.macos.observe", "executed"),
      result: { observed: true },
    }));
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Observe the selected Mac.",
      prompt: "Continue the local task.",
      tools: [modelTool("local_observe")],
      toolbox: {
        byFunctionName: new Map([["local_observe", {
          definition: toolDefinition("local.macos.observe"),
          functionName: "local_observe",
        }]]),
      },
      securityContext: {
        tenantId: "tenant-local",
        actorId: "owner-local",
        role: "admin",
        source: "default",
      },
      runId: "run-local-cap",
      toolSteps: 6,
      maxToolSteps: 12,
      generateTurn,
      executeTool: executeTool as never,
    });

    const collected = await collect(loop);
    expect(executeTool).toHaveBeenCalledOnce();
    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(collected.result).toMatchObject({
      text: "The seventh local round completed.",
      toolSteps: 7,
    });
  });

  it("keeps the six-step fallback when a legacy loop has no persisted cap", async () => {
    const generateTurn = vi.fn(async (request: ModelToolTurnRequest) => {
      expect(request.tools).toEqual([]);
      return turn({ text: "Final answer only." });
    });
    const executeTool = vi.fn();
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Finish within the legacy boundary.",
      prompt: "Finish.",
      tools: [modelTool("memory_search")],
      toolbox: {
        byFunctionName: new Map([["memory_search", {
          definition: toolDefinition("memory.search"),
          functionName: "memory_search",
        }]]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-legacy-cap",
      toolSteps: 6,
      generateTurn,
      executeTool: executeTool as never,
    });

    const collected = await collect(loop);
    expect(collected.result.text).toBe("Final answer only.");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("forces approval only for risk-bearing tools under the voice policy", async () => {
    const executeTool = vi.fn(async (request: {
      toolId: string;
      forceApproval?: boolean;
    }) => ({
      record: executionRecord(request.toolId, "executed"),
      result: { ok: true },
    }));
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "fast",
      instructions: "Use governed tools.",
      prompt: "Read and then update.",
      tools: [modelTool("safe_read"), modelTool("risky_update")],
      toolbox: {
        byFunctionName: new Map([
          ["safe_read", {
            definition: toolDefinition("safe.read"),
            functionName: "safe_read",
          }],
          ["risky_update", {
            definition: toolDefinition("risky.update", { riskLevel: 1 }),
            functionName: "risky_update",
          }],
        ]),
      },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-voice-policy",
      forceApprovalAboveRisk: 0,
      generateTurn: vi.fn()
        .mockResolvedValueOnce(turn({
          toolCalls: [
            { callId: "call-read", name: "safe_read", argumentsJson: "{}" },
            { callId: "call-update", name: "risky_update", argumentsJson: "{}" },
          ],
        }))
        .mockResolvedValueOnce(turn({ text: "Finished." })),
      executeTool: executeTool as never,
    });

    await collect(loop);
    expect(executeTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ toolId: "safe.read", forceApproval: false }),
    );
    expect(executeTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ toolId: "risky.update", forceApproval: true }),
    );
  });

  it("closes the observed model boundary when generation fails", async () => {
    const failure = new Error("provider unavailable");
    const afterModelFailure = vi.fn(async () => undefined);
    const loop = runNonOpenAIProviderToolLoop({
      provider: "google",
      tier: "reasoning",
      instructions: "Answer safely.",
      prompt: "Fail this test turn.",
      tools: [],
      toolbox: { byFunctionName: new Map() },
      securityContext: {
        tenantId: "default",
        actorId: "owner",
        role: "admin",
        source: "default",
      },
      runId: "run-failed-model",
      modelAttemptOffset: 2,
      beforeModelTurn: vi.fn(async () => undefined),
      afterModelFailure,
      generateTurn: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(collect(loop)).rejects.toThrow("provider unavailable");
    expect(afterModelFailure).toHaveBeenCalledWith({
      attempt: 3,
      provider: "google",
      tier: "reasoning",
      error: failure,
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

function computerObservation() {
  return {
    schemaVersion: 1 as const,
    source: "local_macos" as const,
    trust: "untrusted_data" as const,
    executionId: "execution-local-observe",
    operation: "local.macos.observe",
    snapshotRevision: "b".repeat(64),
    pageState: { origin: "https://example.test", title: "Success" },
    accessibilitySnapshot: "- heading \"Success\" [level=1]",
    screenshot: {
      mimeType: "image/webp" as const,
      dataBase64: "UklGRgAAAABXRUJQ",
    },
  };
}

function localObservation() {
  return {
    schemaVersion: 1 as const,
    source: "local_macos" as const,
    trust: "untrusted_data" as const,
    executionId: "execution-local-observe",
    operation: "observe",
    snapshotRevision: "c".repeat(64),
    applicationState: {
      name: "Finder",
      bundleId: "com.apple.finder",
      pid: 123,
    },
    accessibilitySnapshot: "LOCAL_PRIVATE_SNAPSHOT",
    screenshot: {
      mimeType: "image/png" as const,
      dataBase64: "iVBORw0KGgo=",
    },
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
    id?: string;
    name?: string;
    riskLevel?: ToolExecutionRecord["riskLevel"];
    approvalRequired?: boolean;
    reason?: string;
  } = {},
): ToolExecutionRecord {
  return {
    id: overrides.id || `execution-${toolId}`,
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
