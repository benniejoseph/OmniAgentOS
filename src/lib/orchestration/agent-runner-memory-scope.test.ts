import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentPromptMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { personalContextMemoryAccessFromSecurityContext } from "@/lib/memory/personal-context-access";
import { buildPersonalContextConsentAuthorityV1 } from "@/lib/memory/personal-context-consent";
import type { RequestSharedMemoryAccessV1 } from "@/lib/memory/shared-context";
import {
  resumeAgentRunAfterToolApproval,
  runAgent,
} from "@/lib/orchestration/agent-runner";
import type { AgentEvent, AgentRunRequest } from "@/lib/orchestration/types";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import { AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES } from "@/lib/rag/context-engine";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import type { ToolDefinition, ToolExecutionRecord } from "@/lib/tools/types";
import { MAX_ASSIGNED_SKILLS } from "@/lib/skills/limits";
import { builtInSkills } from "@/lib/skills/catalog";
import { getGovernedTool } from "@/lib/tools/registry";
import { DEFAULT_AGENT_RUN_BUDGET_LIMITS } from "@/lib/runs/budgets";

const mocks = vi.hoisted(() => ({
  appendContextCompilerV2CanaryEvent: vi.fn(),
  appendContextCompilerV2AutomaticEvent: vi.fn(),
  appendContextCompilerV2ShadowEventSafely: vi.fn(),
  appendContextUseReceiptEvent: vi.fn(),
  appendAgentRunIdentityPin: vi.fn(),
  appendRunContractEventSafely: vi.fn(),
  appendRunEvent: vi.fn(),
  bindAgentRunExecutionScope: vi.fn(),
  buildContextPack: vi.fn(),
  completeAgentRun: vi.fn(),
  createAgentRun: vi.fn(),
  enqueueMemoryConsolidationJob: vi.fn(),
  getActiveAgentAdaptationGuidance: vi.fn(),
  loadProgressiveAgentTools: vi.fn(),
  markAgentRunWaitingForApproval: vi.fn(),
  recordRuntimeEventSafely: vi.fn(),
  resolvePersonalContextMemoryAccess: vi.fn(),
  runCouncilRound: vi.fn(),
  streamResponseTurn: vi.fn(),
  executeGovernedTool: vi.fn(),
  failAgentRun: vi.fn(),
  findAgentRunWaitingForToolApproval: vi.fn(),
  getAgentRunExecutionScope: vi.fn(),
  getAgentRunIdentityPin: vi.fn(),
  getToolExecutionScopeBinding: vi.fn(),
  syncMissionExecutorSafely: vi.fn(),
  updateRunContextCount: vi.fn(),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    AGENT_MAX_OUTPUT_TOKENS: 128,
    AGENT_MAX_TOOL_STEPS: 1,
    AGENT_REASONING_EFFORT: "minimal",
    hasAnthropicKey: () => false,
    hasGeminiKey: () => false,
    hasOpenAIKey: () => true,
  };
});

vi.mock("@/lib/agents/adaptation-store", () => ({
  getActiveAgentAdaptationGuidance: mocks.getActiveAgentAdaptationGuidance,
}));

vi.mock("@/lib/capabilities/toolbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capabilities/toolbox")>()),
  capabilityFunctionName: (id: string) => id,
  loadProgressiveAgentTools: mocks.loadProgressiveAgentTools,
}));

vi.mock("@/lib/models/registry", () => ({
  hasModelProviderFeature: (feature: string) =>
    feature === "text" || feature === "json_schema" ||
    feature === "tools" || feature === "vision",
  getModelProvider: () => ({
    configured: () => true,
    targets: (tier: "fast" | "reasoning") => [{
      provider: "openai",
      model: "gpt-test",
      tier,
      features: ["text", "streaming", "tools", "json_schema", "vision"],
    }],
  }),
  modelTargets: () => [],
}));

vi.mock("@/lib/openai/client", () => ({
  canonicalConversationFromOpenAIItems: () => [],
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

vi.mock("@/lib/tools/executor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/executor")>()),
  executeGovernedTool: mocks.executeGovernedTool,
}));

vi.mock("@/lib/tools/execution-scope", () => ({
  getToolExecutionScopeBinding: mocks.getToolExecutionScopeBinding,
}));

vi.mock("@/lib/missions/runtime", () => ({
  syncMissionExecutorSafely: mocks.syncMissionExecutorSafely,
}));

vi.mock("@/lib/observability/store", () => ({
  recordRuntimeEventSafely: mocks.recordRuntimeEventSafely,
}));

vi.mock("@/lib/operations/background-jobs", () => ({
  enqueueMemoryConsolidationJob: mocks.enqueueMemoryConsolidationJob,
}));

vi.mock("@/lib/memory/personal-context-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/personal-context-access")>()),
  resolvePersonalContextMemoryAccess:
    mocks.resolvePersonalContextMemoryAccess,
}));

vi.mock("@/lib/orchestration/council", () => ({
  formatCouncilContributions: () => "",
  reviewCouncilResponse: vi.fn(),
  reviseCouncilResponse: vi.fn(),
  runCouncilRound: mocks.runCouncilRound,
}));

vi.mock("@/lib/rag/context-engine", () => ({
  AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES: Object.freeze({
    memory: "authorized_only",
    knowledge: "canonical_authorized",
    topicGraph: "exclude",
    entityGraph: "authorized",
  }),
  buildContextPack: mocks.buildContextPack,
}));

vi.mock("@/lib/runs/store", () => ({
  appendContextCompilerV2AutomaticEvent:
    mocks.appendContextCompilerV2AutomaticEvent,
  appendContextCompilerV2CanaryEvent:
    mocks.appendContextCompilerV2CanaryEvent,
  appendContextCompilerV2ShadowEventSafely:
    mocks.appendContextCompilerV2ShadowEventSafely,
  appendContextUseReceiptEvent: mocks.appendContextUseReceiptEvent,
  appendAgentRunIdentityPin: mocks.appendAgentRunIdentityPin,
  appendRunContractEventSafely: mocks.appendRunContractEventSafely,
  appendRunEvent: mocks.appendRunEvent,
  bindAgentRunExecutionScope: mocks.bindAgentRunExecutionScope,
  cancelAgentRun: vi.fn(),
  completeAgentRun: mocks.completeAgentRun,
  createAgentRun: mocks.createAgentRun,
  createQueuedAgentRun: mocks.createAgentRun,
  failAgentRun: mocks.failAgentRun,
  findAgentRunWaitingForToolApproval:
    mocks.findAgentRunWaitingForToolApproval,
  getAgentRun: vi.fn(),
  getAgentRunExecutionScope: mocks.getAgentRunExecutionScope,
  getAgentRunIdentityPin: mocks.getAgentRunIdentityPin,
  listAgentRunSummaries: vi.fn(),
  markAgentRunResuming: vi.fn(),
  markAgentRunWaitingForApproval: mocks.markAgentRunWaitingForApproval,
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
    mocks.appendRunEvent.mockResolvedValue({
      id: "run-event-a",
      createdAt: "2026-09-06T00:00:00.000Z",
    });
    mocks.appendContextCompilerV2CanaryEvent.mockResolvedValue(undefined);
    mocks.appendContextCompilerV2AutomaticEvent.mockResolvedValue(undefined);
    mocks.appendContextCompilerV2ShadowEventSafely.mockResolvedValue(undefined);
    mocks.appendContextUseReceiptEvent.mockResolvedValue(undefined);
    mocks.appendAgentRunIdentityPin.mockResolvedValue(undefined);
    mocks.appendRunContractEventSafely.mockResolvedValue(undefined);
    mocks.bindAgentRunExecutionScope.mockResolvedValue({ id: "run-memory-scope" });
    mocks.completeAgentRun.mockResolvedValue({ id: "run-memory-scope" });
    mocks.updateRunContextCount.mockResolvedValue(undefined);
    mocks.enqueueMemoryConsolidationJob.mockResolvedValue(null);
    mocks.getActiveAgentAdaptationGuidance.mockResolvedValue([]);
    mocks.loadProgressiveAgentTools.mockResolvedValue({ definitions: [] });
    mocks.markAgentRunWaitingForApproval.mockResolvedValue({ parked: true });
    mocks.recordRuntimeEventSafely.mockResolvedValue(undefined);
    mocks.executeGovernedTool.mockReset();
    mocks.failAgentRun.mockResolvedValue({ id: "run-memory-scope" });
    mocks.findAgentRunWaitingForToolApproval.mockReset();
    mocks.getAgentRunExecutionScope.mockResolvedValue(undefined);
    mocks.getToolExecutionScopeBinding.mockResolvedValue(undefined);
    mocks.syncMissionExecutorSafely.mockResolvedValue(undefined);
    mocks.resolvePersonalContextMemoryAccess.mockImplementation(async (value) =>
      value?.databaseAccessScope
    );
    mocks.buildContextPack.mockImplementation(async (
      _query: string,
      options: {
        contextCompilerV2Automatic?: unknown;
        contextCompilerV2Canary?: unknown;
      },
    ) => ({
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
      budget: {},
      ...(options.contextCompilerV2Automatic
        ? {
            compilerV2Automatic: {
              selectedEvidenceIds: ["memory:private-memory"],
              receipt: { receiptId: "context-automatic-receipt-a" },
            },
          }
        : options.contextCompilerV2Canary
        ? {
            compilerV2Canary: {
              selectedEvidenceIds: ["memory:private-memory"],
              receipt: { receiptId: "context-canary-receipt-a" },
            },
          }
        : {
            compilerV2Shadow: {
              selectedEvidenceIds: [],
              receipt: { receiptId: "context-receipt-a" },
            },
          }),
    }));
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
    expect(mocks.getActiveAgentAdaptationGuidance).not.toHaveBeenCalled();
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

  it("lets a reviewed session scope narrow an all-memory agent", async () => {
    const scopedRequest = request("all");
    scopedRequest.contextScope = "session";

    const events = await collectRequest(scopedRequest);

    expect(mocks.buildContextPack).not.toHaveBeenCalled();
    expect(mocks.enqueueMemoryConsolidationJob).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "harness",
      contextScope: "session",
      contextDecision: "disabled_session",
      budgetLimitsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      contextRationale: [
        "The user limited this run to the current conversation.",
      ],
    }));
  });

  it("shows canonical tool and Skill IDs to the model", async () => {
    const delegate = getGovernedTool("app.agents.delegate");
    const knowledge = getGovernedTool("knowledge.search");
    const runs = getGovernedTool("runs.list");
    const memorySkill = builtInSkills.find((skill) => skill.id === "core.memory");
    if (!delegate || !knowledge || !runs || !memorySkill) {
      throw new Error("Expected canonical delegation fixtures.");
    }
    mocks.loadProgressiveAgentTools.mockResolvedValue({
      definitions: [delegate, knowledge, runs],
    });
    const scopedRequest = request("session");
    scopedRequest.agentProfile!.toolIds = [
      delegate.id,
      knowledge.id,
      runs.id,
    ];
    scopedRequest.agentProfile!.skills = [memorySkill];
    scopedRequest.agentProfile!.approvalPolicy = "risk_based";
    scopedRequest.agentProfile!.autonomy = "governed";

    await collectRequest(scopedRequest);

    const modelRequest = mocks.streamResponseTurn.mock.calls[0]?.[0];
    const delegateTool = modelRequest.tools?.find(
      (tool: { name: string }) => tool.name === "app.agents.delegate",
    );
    const knowledgeTool = modelRequest.tools?.find(
      (tool: { name: string }) => tool.name === "knowledge.search",
    );
    expect(delegateTool?.description).toMatch(
      /^Canonical governed tool ID: app\.agents\.delegate\./,
    );
    expect(delegateTool?.description).toContain(
      "provider callable name is transport-only",
    );
    expect(modelRequest.instructions).toContain(
      "Memory curation (Skill ID: core.memory)",
    );
    expect(knowledgeTool?.description).toMatch(
      /^Canonical governed tool ID: knowledge\.search\./,
    );
  });

  it("reserves explicit dynamic children instead of a redundant automatic council", async () => {
    const delegate = getGovernedTool("app.agents.delegate");
    if (!delegate) throw new Error("Expected governed delegation fixture.");
    mocks.loadProgressiveAgentTools.mockResolvedValue({
      definitions: [delegate],
    });
    mocks.executeGovernedTool
      .mockResolvedValueOnce({
        record: localExecutionRecord(
          delegate.id,
          "execution-delegation-scout",
        ),
        result: { accepted: true },
      })
      .mockResolvedValueOnce({
        record: localExecutionRecord(
          delegate.id,
          "execution-delegation-mnemosyne",
        ),
        result: { accepted: true },
      });
    let modelTurn = 0;
    mocks.streamResponseTurn.mockImplementation(async (modelRequest) => {
      modelTurn += 1;
      if (modelTurn === 1) {
        return openAITurn({
          calls: [
            { callId: "call-delegate-scout", name: delegate.id },
            { callId: "call-delegate-mnemosyne", name: delegate.id },
          ],
        });
      }
      await modelRequest.onDelta("Receipts returned.");
      return openAITurn({ text: "Receipts returned." });
    });
    const scopedRequest = request("session");
    scopedRequest.agentId = "atlas";
    scopedRequest.specialistIds = ["scout", "mnemosyne", "sentinel"];
    scopedRequest.messages = [{
      role: "user",
      content:
        "Please ask Scout to run one isolated read-only check, then ask Mnemosyne to run another.",
    }];
    scopedRequest.budgetLimits = {
      ...DEFAULT_AGENT_RUN_BUDGET_LIMITS,
      agents: 7,
      fanOut: 6,
    };
    scopedRequest.agentProfile!.toolIds = [delegate.id];
    scopedRequest.agentProfile!.approvalPolicy = "risk_based";
    scopedRequest.agentProfile!.autonomy = "governed";

    const events = await collectRequest(scopedRequest);

    expect(mocks.runCouncilRound).not.toHaveBeenCalled();
    expect(mocks.createAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "atlas" }),
    );
    expect(mocks.executeGovernedTool).toHaveBeenCalledTimes(2);
    expect(mocks.executeGovernedTool.mock.calls.map(([input]) => input.toolId))
      .toEqual([delegate.id, delegate.id]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      label: "governed delegation plan active",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "done",
      response: "Receipts returned.",
    }));
  });

  it("keeps the automatic council when no explicit delegation was requested", async () => {
    const delegate = getGovernedTool("app.agents.delegate");
    if (!delegate) throw new Error("Expected governed delegation fixture.");
    mocks.loadProgressiveAgentTools.mockResolvedValue({
      definitions: [delegate],
    });
    mocks.runCouncilRound.mockResolvedValue([]);
    const scopedRequest = request("session");
    scopedRequest.agentId = "atlas";
    scopedRequest.specialistIds = ["scout", "mnemosyne", "sentinel"];
    scopedRequest.messages = [{
      role: "user",
      content: "Compare the available evidence and provide a concise answer.",
    }];
    scopedRequest.agentProfile!.toolIds = [delegate.id];
    scopedRequest.agentProfile!.approvalPolicy = "risk_based";
    scopedRequest.agentProfile!.autonomy = "governed";

    const events = await collectRequest(scopedRequest);

    expect(mocks.runCouncilRound).toHaveBeenCalledOnce();
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "status",
      label: "governed delegation plan active",
    }));
  });

  it("uses semantic capability terms as discovery hints without an allowlist", async () => {
    const scopedRequest = request("session");
    scopedRequest.semanticRouting = {
      capabilitySearchQuery: "create calendar event",
      matchedCapabilityIds: ["calendar.create"],
      policyVersion: "semantic-intent-policy-v2",
    };

    await collectRequest(scopedRequest);

    expect(mocks.loadProgressiveAgentTools).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "paid-test-tenant",
        query: expect.stringMatching(/^create calendar event\b/),
        preferredToolIds: [],
      }),
    );
  });

  it("never exposes tools from assigned Skills omitted from the runtime prompt", async () => {
    const scopedRequest = request("session");
    const skills = Array.from(
      { length: MAX_ASSIGNED_SKILLS + 1 },
      (_, index) => ({
        id: `skill-${index + 1}`,
        name: `Skill ${index + 1}`,
        description: `Description ${index + 1}`,
        instructions: `Instruction ${index + 1}`,
        toolIds: [`skill.tool.${index + 1}`],
      }),
    );
    scopedRequest.agentProfile!.skills = skills;
    mocks.loadProgressiveAgentTools.mockResolvedValue({
      definitions: skills.map((skill) => localToolDefinition(skill.toolIds[0])),
    });

    const events = await collectRequest(scopedRequest);
    const runtimeSkills = skills.slice(0, MAX_ASSIGNED_SKILLS);
    const runtimeToolIds = runtimeSkills.map((skill) => skill.toolIds[0]);

    expect(mocks.loadProgressiveAgentTools).toHaveBeenCalledWith(
      expect.objectContaining({ preferredToolIds: runtimeToolIds }),
    );
    expect(mocks.streamResponseTurn.mock.calls[0]?.[0].instructions).toContain(
      `Skill ${MAX_ASSIGNED_SKILLS}`,
    );
    expect(mocks.streamResponseTurn.mock.calls[0]?.[0].instructions).not.toContain(
      `Skill ${MAX_ASSIGNED_SKILLS + 1}`,
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: "harness",
      skillIds: runtimeSkills.map((skill) => skill.id),
      toolIds: [...runtimeToolIds].sort((left, right) =>
        left.localeCompare(right)
      ),
    }));
  });

  it("fails project mode closed instead of broadening it to tenant memory", async () => {
    const events = await collectRun("project");

    expect(mocks.buildContextPack).not.toHaveBeenCalled();
    expect(mocks.getActiveAgentAdaptationGuidance).not.toHaveBeenCalled();
    expect(mocks.enqueueMemoryConsolidationJob).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      label: "project memory isolated",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "harness",
      conversationSchemaVersion: 1,
      conversationRolesPreserved: true,
      observationsStructured: true,
      contextDecision: "disabled_project_unavailable",
      contextMode: "project_unavailable",
      contextCount: 0,
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
      contextCompilerV2Shadow: expect.objectContaining({
        runId: "run-memory-scope",
      }),
      embeddingPolicy: {
        allowedExternalProviders: ["openai"],
      },
    }));
    expect(mocks.updateRunContextCount).toHaveBeenCalledWith(
      "run-memory-scope",
      0,
    );
    expect(
      mocks.appendContextCompilerV2ShadowEventSafely,
    ).toHaveBeenCalledWith(
      "run-memory-scope",
      { receiptId: "context-receipt-a" },
      expect.objectContaining({ tenantId: "paid-test-tenant" }),
    );
    expect(mocks.getActiveAgentAdaptationGuidance).toHaveBeenCalledWith({
      tenantId: "paid-test-tenant",
      ownerActorId: "paid-test-actor",
      agentId: "paid-test-agent",
      definitionVersion: 1,
    });
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

  it("applies only an owner-activated adaptation to the exact identity pin", async () => {
    mocks.getActiveAgentAdaptationGuidance.mockResolvedValue([{
      adaptationId: `agent-adaptation:${"a".repeat(64)}`,
      activationVersion: 4,
      guidance: "Cite the exact source for material claims.",
      confidence: 0.95,
      evaluationSha256: "b".repeat(64),
    }]);

    const events = await collectRun("all");

    expect(mocks.streamResponseTurn.mock.calls[0]?.[0].instructions).toContain(
      "Activation v4: Cite the exact source for material claims.",
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      label: "activated adaptation ready",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "harness",
      adaptationState: "active",
      adaptationActivationVersions: [4],
    }));
  });

  it("retrieves only the assigned agent's memory and blocks sibling delegation", async () => {
    const scopedRequest = request("all");
    scopedRequest.contextScope = "agent_private";
    scopedRequest.specialistIds = ["scout"];

    const events = await collectRequest(scopedRequest);

    expect(mocks.buildContextPack).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        accessContext: undefined,
        databaseMemoryAccessScope: expect.objectContaining({
          tenantId: "paid-test-tenant",
          initiatingActorId: "paid-test-actor",
          executingPrincipalType: "agent",
          executingPrincipalId: "paid-test-agent",
          purposeId: "memory.retrieve.v1",
        }),
        retrievalSources: AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES,
        persistTrace: false,
      }),
    );
    expect(mocks.getActiveAgentAdaptationGuidance).not.toHaveBeenCalled();
    expect(mocks.runCouncilRound).not.toHaveBeenCalled();
    expect(mocks.enqueueMemoryConsolidationJob).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      label: "private context isolated",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "harness",
      contextScope: "agent_private",
      contextDecision: "retrieved",
    }));
  });

  it("keeps one-turn This Mac evidence with the assigned agent", async () => {
    const scopedRequest = request("session");
    scopedRequest.computerUseTarget = "local_macos";
    scopedRequest.specialistIds = ["sentinel"];

    const events = await collectRequest(scopedRequest);

    expect(mocks.runCouncilRound).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      label: "This Mac evidence isolated",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "harness",
      maxToolSteps: 12,
      budgetLimits: expect.objectContaining({ modelTurns: 14 }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "council_verdict",
      status: "revised",
    }));
  });

  it("does not infer computer authority from natural browser wording", async () => {
    const scopedRequest = request("session");
    scopedRequest.messages = [{
      role: "user",
      content: "Open Chrome and show me the chart at https://example.test/chart",
    }];

    const events = await collectRequest(scopedRequest);

    expect(events).not.toContainEqual(expect.objectContaining({
      type: "status",
      label: "This Mac connected",
    }));
    expect(mocks.loadProgressiveAgentTools).toHaveBeenCalledWith(
      expect.objectContaining({ preferredToolIds: [] }),
    );
    expect(JSON.stringify(mocks.streamResponseTurn.mock.calls[0]?.[0]))
      .not.toContain("Computer Use — This Mac");
  });

  it("terminates a persisted Isolated Browser continuation without retargeting", async () => {
    const continuation = {
      computerUseTarget: "isolated_browser" as const,
      conversationItems: [],
      instructions: "Legacy instructions.",
      response: "",
      toolSteps: 1,
      outputsBeforeApproval: [],
      pendingToolCall: {
        callId: "call-retired-browser",
        toolId: "mcp:playwright:browser_click",
        toolName: "Click",
        executionId: "execution-retired-browser",
      },
      context: {
        tenantId: "paid-test-tenant",
        actorId: "paid-test-actor",
        role: "admin" as const,
      },
      createdAt: "2026-09-17T00:00:00.000Z",
    };
    mocks.findAgentRunWaitingForToolApproval.mockResolvedValue({
      id: "run-retired-browser",
      tenantId: "paid-test-tenant",
      ownerActorId: "paid-test-actor",
      mode: "execute",
      status: "waiting_approval",
      prompt: "Continue in the old browser.",
      messages: [{ role: "user", content: "Continue." }],
      memoryContextCount: 0,
      startedAt: "2026-09-17T00:00:00.000Z",
      continuation,
    });

    const outcome = await resumeAgentRunAfterToolApproval({
      executionId: "execution-retired-browser",
      tenantId: "paid-test-tenant",
      toolExecution: {
        record: {
          id: "execution-retired-browser",
          tenantId: "paid-test-tenant",
          toolId: "mcp:playwright:browser_click",
          toolName: "Click",
          riskLevel: 2,
          status: "executed",
          dryRun: false,
          approvalRequired: true,
          input: {},
          createdAt: "2026-09-17T00:00:00.000Z",
        },
      },
    });

    expect(outcome).toMatchObject({
      resumed: true,
      status: "failed",
      code: "computer_use_target_retired",
    });
    expect(mocks.appendRunEvent).toHaveBeenCalledWith(
      "run-retired-browser",
      expect.objectContaining({
        type: "execution_target_retired",
        target: "isolated_browser",
      }),
      expect.any(Object),
    );
    expect(mocks.failAgentRun).toHaveBeenCalledWith(
      "run-retired-browser",
      expect.stringContaining("without executing or being redirected"),
      expect.any(Object),
    );
    expect(mocks.streamResponseTurn).not.toHaveBeenCalled();
    expect(mocks.executeGovernedTool).not.toHaveBeenCalled();
  });

  it("retains the exact This Mac target when a governed action pauses", async () => {
    const scopedRequest = request("session");
    scopedRequest.computerUseTarget = "local_macos";
    scopedRequest.agentProfile!.toolIds = ["local.macos.open_url"];
    scopedRequest.agentProfile!.approvalPolicy = "risk_based";
    scopedRequest.agentProfile!.autonomy = "governed";
    mocks.loadProgressiveAgentTools.mockResolvedValue({
      definitions: [{
        ...localToolDefinition("local.macos.open_url"),
        riskLevel: 2,
        approvalRequired: true,
        operationClass: "mutation",
        reversible: false,
      }],
    });
    mocks.executeGovernedTool.mockResolvedValue({
      record: {
        ...localExecutionRecord(
          "local.macos.open_url",
          "execution-local-open-url",
        ),
        riskLevel: 2,
        status: "approval_required",
        approvalRequired: true,
      },
    });
    mocks.streamResponseTurn.mockResolvedValue(openAITurn({
      callId: "call-open-url",
      name: "local.macos.open_url",
    }));

    const events = await collectRequest(scopedRequest);

    expect(events).toContainEqual(expect.objectContaining({
      type: "waiting_approval",
      toolId: "local.macos.open_url",
    }));
    expect(mocks.markAgentRunWaitingForApproval).toHaveBeenCalledWith(
      "run-memory-scope",
      expect.objectContaining({
        continuation: expect.objectContaining({
          computerUseTarget: "local_macos",
        }),
      }),
    );
  });

  it("carries direct OpenAI local evidence through one immediate app list without persisting it", async () => {
    const scopedRequest = request("session");
    scopedRequest.computerUseTarget = "local_macos";
    scopedRequest.agentProfile!.toolIds = [
      "local.macos.observe",
      "local.macos.list_apps",
    ];
    mocks.loadProgressiveAgentTools.mockResolvedValue({
      definitions: [
        localToolDefinition("local.macos.observe"),
        localToolDefinition("local.macos.list_apps"),
      ],
    });
    mocks.executeGovernedTool.mockImplementation(async ({ toolId }) =>
      toolId === "local.macos.observe"
        ? {
            record: localExecutionRecord(toolId, "execution-local-observe"),
            result: { summary: "Observed Finder." },
            computerObservation: localObservation(),
          }
        : {
            record: localExecutionRecord(toolId, "execution-local-list"),
            result: { applications: ["Finder", "Chrome"] },
          }
    );
    let modelTurn = 0;
    mocks.streamResponseTurn.mockImplementation(async (modelRequest) => {
      modelTurn += 1;
      if (modelTurn === 1) {
        return openAITurn({
          callId: "call-observe",
          name: "local.macos.observe",
        });
      }
      if (modelTurn === 2) {
        expect(modelRequest.input).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: "ephemeral_computer_function_output",
            call_id: "call-observe",
            observation: expect.objectContaining({
              source: "local_macos",
              snapshotRevision: "f".repeat(64),
            }),
          }),
        ]));
        return openAITurn({
          callId: "call-list-apps",
          name: "local.macos.list_apps",
        });
      }
      expect(modelRequest.input).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "ephemeral_computer_function_output",
          call_id: "call-list-apps",
          observation: expect.objectContaining({
            source: "local_macos",
            executionId: "execution-local-observe",
          }),
        }),
      ]));
      await modelRequest.onDelta("Done.");
      return openAITurn({ text: "Done." });
    });

    const events = await collectRequest(scopedRequest);

    expect(events).toContainEqual(expect.objectContaining({
      type: "done",
      response: "Done.",
    }));
    expect(mocks.streamResponseTurn).toHaveBeenCalledTimes(3);
    expect(mocks.executeGovernedTool).toHaveBeenCalledTimes(2);
    const durableWrites = JSON.stringify({
      events: mocks.appendRunEvent.mock.calls,
      completion: mocks.completeAgentRun.mock.calls,
    });
    expect(durableWrites).not.toContain("LOCAL_OPENAI_PRIVATE_SNAPSHOT");
    expect(durableWrites).not.toContain("iVBORw0KGgo=");
    expect(durableWrites).not.toContain("ephemeral_computer_function_output");
  });

  it("returns the governed execution ID to an OpenAI tool caller", async () => {
    const scopedRequest = request("session");
    scopedRequest.agentProfile!.toolIds = ["knowledge.search"];
    mocks.loadProgressiveAgentTools.mockResolvedValue({
      definitions: [localToolDefinition("knowledge.search")],
    });
    mocks.executeGovernedTool.mockResolvedValue({
      record: localExecutionRecord(
        "knowledge.search",
        "execution-knowledge-search",
      ),
      result: { results: [] },
    });
    let modelTurn = 0;
    mocks.streamResponseTurn.mockImplementation(async (modelRequest) => {
      modelTurn += 1;
      if (modelTurn === 1) {
        return openAITurn({
          callId: "call-knowledge-search",
          name: "knowledge.search",
        });
      }
      const toolOutput = modelRequest.input.find(
        (item: { type?: string }) => item.type === "function_call_output",
      );
      expect(toolOutput).toBeDefined();
      expect(JSON.parse((toolOutput as { output: string }).output)).toMatchObject({
        provenance: "tool_result",
        data: {
          executionId: "execution-knowledge-search",
          status: "executed",
        },
      });
      await modelRequest.onDelta("Done.");
      return openAITurn({ text: "Done." });
    });

    const events = await collectRequest(scopedRequest);

    expect(events).toContainEqual(expect.objectContaining({
      type: "done",
      response: "Done.",
    }));
    expect(mocks.streamResponseTurn).toHaveBeenCalledTimes(2);
  });

  it("revalidates standing consent and isolates automatic personal context", async () => {
    const authority = buildPersonalContextConsentAuthorityV1({
      tenantId: privateOwnerContext.tenantId,
      actorId: `actor:${privateOwnerContext.auth.userId}`,
      consentGeneration: 1,
      activatedAt: "2026-09-06T00:00:00.000Z",
    });
    const promptAccess = personalContextMemoryAccessFromSecurityContext(
      privateOwnerContext,
      { correlationId: "personal-context-request", consentAuthority: authority },
    );
    const scopedRequest = request("all");
    scopedRequest.actorId = privateOwnerContext.actorId;
    scopedRequest.contextScope = "personal";
    scopedRequest.executionScope = createExecutionScope({
      tenantId: privateOwnerContext.tenantId,
      initiatingActorId: `actor:${privateOwnerContext.auth.userId}`,
      executingPrincipalType: "agent",
      executingPrincipalId: "paid-test-agent",
      correlationId: "personal-context-request",
      purpose: "agent.run",
    });
    scopedRequest.promptPersonalMemoryAccess = promptAccess;
    scopedRequest.specialistIds = ["scout"];

    const events = await collectRequest(scopedRequest);

    expect(mocks.resolvePersonalContextMemoryAccess).toHaveBeenCalledWith(
      promptAccess,
      expect.objectContaining({
        agentExecutionScope: scopedRequest.executionScope,
        memoryMode: "all",
      }),
    );
    expect(mocks.buildContextPack).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        databaseMemoryAccessScope: promptAccess?.databaseAccessScope,
        retrievalSources: AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES,
        persistTrace: false,
        contextCompilerV2Automatic: expect.objectContaining({
          runId: "run-memory-scope",
        }),
      }),
    );
    expect(mocks.appendContextCompilerV2AutomaticEvent).toHaveBeenCalledWith(
      "run-memory-scope",
      { receiptId: "context-automatic-receipt-a" },
      expect.objectContaining({ tenantId: "paid-test-tenant" }),
    );
    expect(mocks.loadProgressiveAgentTools).not.toHaveBeenCalled();
    expect(mocks.runCouncilRound).not.toHaveBeenCalled();
    expect(mocks.enqueueMemoryConsolidationJob).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      label: "retrieving personal context",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      label: "personal context isolated",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "harness",
      contextScope: "personal",
      contextDecision: "retrieved",
      toolCount: 0,
      contextRationale: [
        "Only relevant owner-private memory covered by active standing consent was eligible.",
      ],
    }));
  });

  it("compiles only the explicitly selected project scope without private consolidation", async () => {
    const scopedRequest = request("all");
    scopedRequest.actorId = privateOwnerContext.actorId;
    scopedRequest.contextScope = "project";
    scopedRequest.executionScope = createExecutionScope({
      tenantId: privateOwnerContext.tenantId,
      initiatingActorId: privateOwnerContext.actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "paid-test-agent",
      workspaceId: "workspace:team-a",
      projectId: "project:launch",
      correlationId: "project-context-request",
      purpose: "agent.run",
    });
    scopedRequest.promptSharedMemoryAccess = sharedProjectAccess();
    scopedRequest.specialistIds = ["scout"];

    const events = await collectRequest(scopedRequest);

    expect(mocks.buildContextPack).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        accessContext: undefined,
        databaseMemoryAccessScope:
          scopedRequest.promptSharedMemoryAccess.databaseAccessScope,
        retrievalSources: AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES,
        persistTrace: false,
        contextCompilerV2Shadow: expect.objectContaining({
          runId: "run-memory-scope",
          authorizedInitiatingActorIds:
            scopedRequest.promptSharedMemoryAccess.actorBinding.readableOwnerActorIds,
        }),
      }),
    );
    expect(mocks.appendContextCompilerV2ShadowEventSafely).toHaveBeenCalledWith(
      "run-memory-scope",
      { receiptId: "context-receipt-a" },
      expect.objectContaining({ tenantId: "paid-test-tenant" }),
    );
    expect(mocks.appendContextCompilerV2CanaryEvent).not.toHaveBeenCalled();
    expect(mocks.runCouncilRound).not.toHaveBeenCalled();
    expect(mocks.enqueueMemoryConsolidationJob).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      label: "retrieving shared project context",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      label: "shared context bounded",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "harness",
      contextScope: "project",
      contextDecision: "retrieved",
      contextRationale: [
        "Only durable knowledge from the explicitly selected project was eligible.",
      ],
    }));
  });

  it("compiles Mission context only through its canonical Project authority", async () => {
    const scopedRequest = request("all");
    scopedRequest.actorId = privateOwnerContext.actorId;
    scopedRequest.contextScope = "mission";
    scopedRequest.executionScope = createExecutionScope({
      tenantId: privateOwnerContext.tenantId,
      initiatingActorId: privateOwnerContext.actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "paid-test-agent",
      workspaceId: "workspace:team-a",
      projectId: "project:launch",
      missionId: "legacy-project-a",
      correlationId: "project-context-request",
      purpose: "agent.run",
    });
    scopedRequest.promptSharedMemoryAccess = sharedProjectAccess();

    const events = await collectRequest(scopedRequest);

    expect(mocks.buildContextPack).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        databaseMemoryAccessScope:
          scopedRequest.promptSharedMemoryAccess.databaseAccessScope,
        retrievalSources: AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES,
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      label: "retrieving shared mission context",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "harness",
      contextScope: "mission",
      contextDecision: "retrieved",
      contextRationale: [
        "Only durable knowledge from the Mission's canonical Project membership was eligible.",
      ],
    }));
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
    scopedRequest.contextSelection = lockedSelection(["memory:private-memory"]);
    scopedRequest.promptMemoryAccess = promptAccess;
    scopedRequest.specialistIds = ["scout"];

    const events = await collectRequest(scopedRequest);

    expect(mocks.buildContextPack).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        accessContext: undefined,
        databaseMemoryAccessScope: promptAccess?.databaseAccessScope,
        evidenceIds: ["memory:private-memory"],
        contextCompilerV2Canary: expect.objectContaining({
          runId: "run-memory-scope",
        }),
      }),
    );
    expect(mocks.appendContextCompilerV2CanaryEvent).toHaveBeenCalledWith(
      "run-memory-scope",
      { receiptId: "context-canary-receipt-a" },
      expect.objectContaining({ tenantId: "paid-test-tenant" }),
    );
    expect(mocks.appendContextCompilerV2ShadowEventSafely).not.toHaveBeenCalled();
    expect(mocks.appendContextUseReceiptEvent).toHaveBeenCalledWith(
      "run-memory-scope",
      expect.objectContaining({
        userInclusionIds: ["memory:private-memory"],
        actualEvidenceIds: [],
      }),
      expect.objectContaining({ tenantId: "paid-test-tenant" }),
    );
    expect(mocks.runCouncilRound).not.toHaveBeenCalled();
    expect(mocks.loadProgressiveAgentTools).not.toHaveBeenCalled();
    expect(mocks.enqueueMemoryConsolidationJob).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "status",
      label: "private context isolated",
    }));
  });

  it("blocks private disclosure when the canary receipt cannot persist", async () => {
    const promptAccess = agentPromptMemoryAccessFromSecurityContext(
      privateOwnerContext,
      { correlationId: "agent-private-receipt-failure" },
    );
    const scopedRequest = request("all");
    scopedRequest.actorId = privateOwnerContext.actorId;
    scopedRequest.executionScope = createExecutionScope({
      tenantId: privateOwnerContext.tenantId,
      initiatingActorId: privateOwnerContext.actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "paid-test-agent",
      correlationId: "agent-private-receipt-failure",
      purpose: "agent.run",
    });
    scopedRequest.contextSelection = lockedSelection(["memory:private-memory"]);
    scopedRequest.promptMemoryAccess = promptAccess;
    mocks.appendContextCompilerV2CanaryEvent.mockRejectedValueOnce(
      new Error("receipt unavailable"),
    );

    const events = await collectRequest(scopedRequest);
    expect(events).toContainEqual({
      type: "error",
      message: "receipt unavailable",
    });
    expect(mocks.streamResponseTurn).not.toHaveBeenCalled();
  });

  it("blocks locked context disclosure when its use receipt cannot persist", async () => {
    const promptAccess = agentPromptMemoryAccessFromSecurityContext(
      privateOwnerContext,
      { correlationId: "agent-context-use-receipt-failure" },
    );
    const scopedRequest = request("all");
    scopedRequest.actorId = privateOwnerContext.actorId;
    scopedRequest.executionScope = createExecutionScope({
      tenantId: privateOwnerContext.tenantId,
      initiatingActorId: privateOwnerContext.actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "paid-test-agent",
      correlationId: "agent-context-use-receipt-failure",
      purpose: "agent.run",
    });
    scopedRequest.contextSelection = lockedSelection(["memory:private-memory"]);
    scopedRequest.promptMemoryAccess = promptAccess;
    mocks.appendContextUseReceiptEvent.mockRejectedValueOnce(
      new Error("context receipt unavailable"),
    );

    const events = await collectRequest(scopedRequest);
    expect(events).toContainEqual({
      type: "error",
      message: "context receipt unavailable",
    });
    expect(mocks.streamResponseTurn).not.toHaveBeenCalled();
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
    scopedRequest.contextSelection = lockedSelection(["memory:private-memory"]);
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

function lockedSelection(evidenceIds: string[]): NonNullable<AgentRunRequest["contextSelection"]> {
  return {
    schemaVersion: 1,
    lockId: "ba37bd71-fbda-4fa7-a12c-b03c28772b03",
    previewId: "cf7b28a6-97ea-4fb0-bb34-5054c3ca7a69",
    query: "hello",
    querySha256: "a".repeat(64),
    candidateEvidenceIds: [...evidenceIds],
    evidenceIds: [...evidenceIds],
    excludedEvidenceIds: [],
    candidateSetSha256: "b".repeat(64),
    contextPackSha256: "c".repeat(64),
    previewReceiptSha256: "d".repeat(64),
    selectionSha256: "e".repeat(64),
    issuedAt: "2026-09-06T00:00:00.000Z",
    expiresAt: "2026-09-06T00:30:00.000Z",
  };
}

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

async function collectRun(memoryScope: "session" | "project" | "all") {
  return collectRequest(request(memoryScope));
}

async function collectRequest(agentRequest: AgentRunRequest) {
  const events: AgentEvent[] = [];
  for await (const event of runAgent(agentRequest)) events.push(event);
  return events;
}

function request(
  memoryScope: "session" | "project" | "all",
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
      persona: DEFAULT_CUSTOM_AGENT_PERSONA,
      modelPolicy: "openai_fast",
      autonomy: "assist",
      approvalPolicy: "read_only",
      memoryScope,
      toolIds: [],
      skills: [],
    },
  };
}

function localToolDefinition(id: string): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    category: "app",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "read_only",
    reversible: true,
    inputSchema: { type: "object" },
  };
}

function localExecutionRecord(
  toolId: string,
  id: string,
): ToolExecutionRecord {
  return {
    id,
    toolId,
    toolName: toolId,
    riskLevel: 0,
    status: "executed",
    dryRun: false,
    approvalRequired: false,
    input: {},
    createdAt: "2026-09-17T00:00:00.000Z",
  };
}

function localObservation() {
  return {
    schemaVersion: 1 as const,
    source: "local_macos" as const,
    trust: "untrusted_data" as const,
    executionId: "execution-local-observe",
    operation: "observe",
    snapshotRevision: "f".repeat(64),
    applicationState: {
      name: "Finder",
      bundleId: "com.apple.finder",
      pid: 123,
    },
    accessibilitySnapshot: "LOCAL_OPENAI_PRIVATE_SNAPSHOT",
    screenshot: {
      mimeType: "image/png" as const,
      dataBase64: "iVBORw0KGgo=",
    },
  };
}

function openAITurn(input: {
  callId?: string;
  name?: string;
  calls?: readonly { callId: string; name: string }[];
  text?: string;
}) {
  const functionCalls = input.calls?.map((call) => ({
    ...call,
    argumentsJson: "{}",
  })) || (input.callId && input.name
    ? [{
        callId: input.callId,
        name: input.name,
        argumentsJson: "{}",
      }]
    : []);
  return {
    responseId: `response-${input.callId || "done"}`,
    functionCalls,
    functionCallItems: functionCalls.map((call) => ({
      type: "function_call" as const,
      id: `item-${call.callId}`,
      call_id: call.callId,
      name: call.name,
      arguments: call.argumentsJson,
    })),
    text: input.text || "",
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
      provider: "openai" as const,
      model: "gpt-test",
      status: "completed" as const,
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
}

function sharedProjectAccess(): RequestSharedMemoryAccessV1 {
  const authorityBody = {
    schemaVersion: 1 as const,
    policyVersion: "workspace-context-policy-v1" as const,
    tenantId: privateOwnerContext.tenantId,
    scope: "project" as const,
    initiatingActorId: `actor:${privateOwnerContext.auth.userId}`,
    workspaceId: "workspace:team-a",
    projectId: "project:launch",
    requestedProjectId: "legacy-project-a",
    accessLevel: "manager" as const,
    canWrite: true,
  };
  const executionScope = createExecutionScope({
    tenantId: privateOwnerContext.tenantId,
    initiatingActorId: authorityBody.initiatingActorId,
    executingPrincipalType: "user",
    executingPrincipalId: authorityBody.initiatingActorId,
    workspaceId: authorityBody.workspaceId,
    projectId: authorityBody.projectId,
    correlationId: "project-context-request",
    purpose: "agent.context.shared.retrieve",
  });
  return {
    actorBinding: {
      version: 1,
      kind: "auth_user",
      authUserId: privateOwnerContext.auth.userId,
      canonicalActorId: authorityBody.initiatingActorId,
      legacyOwnerActorIds: [privateOwnerContext.actorId],
      readableOwnerActorIds: [
        authorityBody.initiatingActorId,
        privateOwnerContext.actorId,
      ],
    },
    authority: {
      ...authorityBody,
      authoritySha256: sourceContractSha256(authorityBody),
    },
    executionScope,
    databaseAccessScope: {
      version: 1,
      tenantId: privateOwnerContext.tenantId,
      initiatingActorId: authorityBody.initiatingActorId,
      executingPrincipalType: "user",
      executingPrincipalId: authorityBody.initiatingActorId,
      workspaceId: authorityBody.workspaceId,
      projectId: authorityBody.projectId,
      missionId: null,
      contextGrantIds: [],
      capabilityGrantIds: [],
      purposeId: "memory.retrieve.v1",
      purpose: "Retrieve explicitly selected shared workspace context.",
    },
  };
}
