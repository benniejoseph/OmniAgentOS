import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentPromptMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { runAgent } from "@/lib/orchestration/agent-runner";
import type { AgentEvent, AgentRunRequest } from "@/lib/orchestration/types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const mocks = vi.hoisted(() => ({
  appendRunEvent: vi.fn(),
  bindAgentRunExecutionScope: vi.fn(),
  buildContextPack: vi.fn(),
  completeAgentRun: vi.fn(),
  createAgentRun: vi.fn(),
  enqueueMemoryConsolidationJob: vi.fn(),
  getAgentLearningGuidance: vi.fn(),
  loadProgressiveAgentTools: vi.fn(),
  recordRuntimeEventSafely: vi.fn(),
  streamResponseTurn: vi.fn(),
  updateRunContextCount: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  AGENT_MAX_OUTPUT_TOKENS: 128,
  AGENT_MAX_TOOL_STEPS: 1,
  AGENT_REASONING_EFFORT: "minimal",
  hasAnthropicKey: () => false,
  hasGeminiKey: () => false,
  hasOpenAIKey: () => true,
}));

vi.mock("@/lib/agents/learning", () => ({
  getAgentLearningGuidance: mocks.getAgentLearningGuidance,
}));

vi.mock("@/lib/capabilities/toolbox", () => ({
  capabilityFunctionName: (id: string) => id,
  loadProgressiveAgentTools: mocks.loadProgressiveAgentTools,
}));

vi.mock("@/lib/models/registry", () => ({
  hasModelProviderFeature: (feature: string) => feature === "text",
}));

vi.mock("@/lib/openai/client", () => ({
  streamResponseTurn: mocks.streamResponseTurn,
}));

vi.mock("@/lib/openai/model-router", () => ({
  selectAgentModel: () => ({
    model: "gpt-test",
    provider: "openai",
    tier: "fast",
    reason: "Test route",
  }),
}));

vi.mock("@/lib/observability/store", () => ({
  recordRuntimeEventSafely: mocks.recordRuntimeEventSafely,
}));

vi.mock("@/lib/operations/background-jobs", () => ({
  enqueueMemoryConsolidationJob: mocks.enqueueMemoryConsolidationJob,
}));

vi.mock("@/lib/orchestration/council", () => ({
  formatCouncilContributions: () => "",
  reviewCouncilResponse: vi.fn(),
  reviseCouncilResponse: vi.fn(),
  runCouncilRound: vi.fn(),
}));

vi.mock("@/lib/rag/context-engine", () => ({
  buildContextPack: mocks.buildContextPack,
}));

vi.mock("@/lib/runs/store", () => ({
  appendRunEvent: mocks.appendRunEvent,
  bindAgentRunExecutionScope: mocks.bindAgentRunExecutionScope,
  cancelAgentRun: vi.fn(),
  completeAgentRun: mocks.completeAgentRun,
  createAgentRun: mocks.createAgentRun,
  failAgentRun: vi.fn(),
  findAgentRunWaitingForToolApproval: vi.fn(),
  getAgentRun: vi.fn(),
  markAgentRunResuming: vi.fn(),
  markAgentRunWaitingForApproval: vi.fn(),
  updateRunContextCount: mocks.updateRunContextCount,
}));

vi.mock("@/lib/web-search/search", () => ({
  formatLiveWebSearchContext: vi.fn(),
  runLiveWebSearch: vi.fn(),
  shouldUseLiveWebSearch: () => false,
}));

describe("agent memory scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAgentRun.mockResolvedValue({
      id: "run-memory-scope",
      tenantId: "paid-test-tenant",
      agentId: "paid-test-agent",
    });
    mocks.appendRunEvent.mockResolvedValue(undefined);
    mocks.bindAgentRunExecutionScope.mockResolvedValue({ id: "run-memory-scope" });
    mocks.completeAgentRun.mockResolvedValue({ id: "run-memory-scope" });
    mocks.updateRunContextCount.mockResolvedValue(undefined);
    mocks.enqueueMemoryConsolidationJob.mockResolvedValue(null);
    mocks.getAgentLearningGuidance.mockResolvedValue([]);
    mocks.loadProgressiveAgentTools.mockResolvedValue({ definitions: [] });
    mocks.recordRuntimeEventSafely.mockResolvedValue(undefined);
    mocks.buildContextPack.mockResolvedValue({
      query: "hello",
      profile: {
        mode: "memory_first",
        intent: "personal",
        shouldRetrieve: true,
        complexity: 0.4,
        queryTerms: ["hello"],
        expandedQueries: ["hello"],
        rationale: ["Persistent memory enabled."],
      },
      results: [],
      memoryResults: [],
      knowledgeResults: [],
      graphResults: [],
      contextBlock: "DURABLE_MEMORY_CONTEXT",
    });
    mocks.streamResponseTurn.mockImplementation(async (request) => {
      await request.onDelta("ASAEL_LIVE_OK");
      return {
        responseId: "response-memory-scope",
        functionCalls: [],
        functionCallItems: [],
        text: "ASAEL_LIVE_OK",
        model: "gpt-test",
        fallbackUsed: false,
        latencyMs: 1,
        usage: {
          inputTokens: 5,
          outputTokens: 2,
          cachedInputTokens: 0,
          totalTokens: 7,
        },
        attempts: [{
          provider: "openai",
          model: "gpt-test",
          status: "completed",
          latencyMs: 1,
          usage: {
            inputTokens: 5,
            outputTokens: 2,
            cachedInputTokens: 0,
            totalTokens: 7,
          },
        }],
        usageReceiptRecorded: false,
      };
    });
  });

  it("keeps a session-only paid turn out of durable retrieval and memory events", async () => {
    const events = await collectRun("session");

    expect(mocks.buildContextPack).not.toHaveBeenCalled();
    expect(mocks.updateRunContextCount).not.toHaveBeenCalled();
    expect(mocks.getAgentLearningGuidance).not.toHaveBeenCalled();
    expect(mocks.enqueueMemoryConsolidationJob).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "memory")).toBe(false);
    expect(
      mocks.appendRunEvent.mock.calls.some(
        ([, event]) => event?.type === "memory",
      ),
    ).toBe(false);
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "status",
      label: "retrieving memory",
    }));
    expect(JSON.stringify(mocks.streamResponseTurn.mock.calls[0]?.[0].input))
      .not.toContain("DURABLE_MEMORY_CONTEXT");
  });

  it("preserves durable retrieval and its receipt for persistent memory", async () => {
    const events = await collectRun("all");

    expect(mocks.buildContextPack).toHaveBeenCalledOnce();
    expect(mocks.buildContextPack).toHaveBeenCalledWith("hello", expect.objectContaining({
      limit: 8,
      tenantId: "paid-test-tenant",
    }));
    expect(mocks.updateRunContextCount).toHaveBeenCalledWith(
      "run-memory-scope",
      0,
    );
    expect(mocks.getAgentLearningGuidance).toHaveBeenCalledWith(
      "paid-test-agent",
      { tenantId: "paid-test-tenant" },
    );
    expect(mocks.enqueueMemoryConsolidationJob).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({
      type: "memory",
      count: 0,
    }));
    expect(mocks.appendRunEvent).toHaveBeenCalledWith(
      "run-memory-scope",
      expect.objectContaining({ type: "memory", count: 0 }),
      expect.objectContaining({ tenantId: "paid-test-tenant" }),
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      label: "retrieving memory",
    }));
    expect(JSON.stringify(mocks.streamResponseTurn.mock.calls[0]?.[0].input))
      .toContain("DURABLE_MEMORY_CONTEXT");
  });

  it("compiles explicitly selected owner-private memory into a direct run", async () => {
    const promptAccess = agentPromptMemoryAccessFromSecurityContext(
      privateOwnerContext,
      { correlationId: "agent-private-request" },
    );
    const scopedRequest = request("all");
    scopedRequest.actorId = privateOwnerContext.actorId;
    scopedRequest.executionScope = createExecutionScope({
      tenantId: privateOwnerContext.tenantId,
      initiatingActorId: privateOwnerContext.actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "paid-test-agent",
      correlationId: "agent-private-request",
      purpose: "agent.run",
    });
    scopedRequest.contextSelection = {
      query: "hello",
      evidenceIds: ["memory:private-memory"],
    };
    scopedRequest.promptMemoryAccess = promptAccess;

    await collectRequest(scopedRequest);

    expect(mocks.buildContextPack).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        accessContext: undefined,
        databaseMemoryAccessScope: promptAccess?.databaseAccessScope,
        evidenceIds: ["memory:private-memory"],
      }),
    );
  });

  it("fails closed when private prompt access belongs to another request", async () => {
    const scopedRequest = request("all");
    scopedRequest.actorId = privateOwnerContext.actorId;
    scopedRequest.executionScope = createExecutionScope({
      tenantId: privateOwnerContext.tenantId,
      initiatingActorId: privateOwnerContext.actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "paid-test-agent",
      correlationId: "agent-private-request-b",
      purpose: "agent.run",
    });
    scopedRequest.contextSelection = {
      query: "hello",
      evidenceIds: ["memory:private-memory"],
    };
    scopedRequest.promptMemoryAccess =
      agentPromptMemoryAccessFromSecurityContext(privateOwnerContext, {
        correlationId: "agent-private-request-a",
      });

    await expect(collectRequest(scopedRequest)).rejects.toThrow(
      "Explicit private-memory prompt access is invalid.",
    );
    expect(mocks.buildContextPack).not.toHaveBeenCalled();
  });
});

const privateOwnerContext = {
  tenantId: "paid-test-tenant",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
    sessionId: "session-private-owner",
    tenantName: "Paid test tenant",
  },
} satisfies SecurityContext;

async function collectRun(memoryScope: "session" | "all") {
  return collectRequest(request(memoryScope));
}

async function collectRequest(agentRequest: AgentRunRequest) {
  const events: AgentEvent[] = [];
  for await (const event of runAgent(agentRequest)) events.push(event);
  return events;
}

function request(
  memoryScope: "session" | "all",
): AgentRunRequest {
  return {
    messages: [{ role: "user", content: "hello" }],
    mode: "orchestrate",
    tenantId: "paid-test-tenant",
    actorId: "paid-test-actor",
    role: "admin",
    agentId: "paid-test-agent",
    agentProfile: {
      name: "Paid test agent",
      role: "Release verifier",
      description: "Verifies one paid model turn.",
      instructions: "Reply only ASAEL_LIVE_OK",
      modelPolicy: "openai_fast",
      autonomy: "assist",
      approvalPolicy: "read_only",
      memoryScope,
      toolIds: [],
      skills: [],
    },
  };
}
