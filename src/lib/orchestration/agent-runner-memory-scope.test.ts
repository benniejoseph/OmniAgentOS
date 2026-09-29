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
import type { ModelToolCall, ModelToolTurnResult } from "@/lib/models/types";
import type { AgentRunContinuation } from "@/lib/runs/types";
import type { ConversationItem } from "@/lib/openai/client";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import { AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES } from "@/lib/rag/context-engine";
import {
  publicGroundingReport,
  type GroundingReport,
} from "@/lib/rag/citations";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import type { ToolDefinition, ToolExecutionRecord } from "@/lib/tools/types";
import { MAX_ASSIGNED_SKILLS } from "@/lib/skills/limits";
import { builtInSkills } from "@/lib/skills/catalog";
import { getGovernedTool } from "@/lib/tools/registry";
import {
  DEFAULT_AGENT_RUN_BUDGET_LIMITS,
  estimateModelInputTokens,
} from "@/lib/runs/budgets";
import { TENANT_DAILY_MAX_TOKENS } from "@/lib/config";
import { AgentRunTerminatedError } from "@/lib/runs/cancellation";
import {
  ModelRouteUnavailableError,
  type RuntimeModelResolution,
} from "@/lib/settings/runtime-models";

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
  cancelAgentRun: vi.fn(),
  completeAgentRun: vi.fn(),
  createAgentRun: vi.fn(),
  createAgentRunCancellationWatch: vi.fn(),
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
  generateModelToolTurn: vi.fn(),
  getAgentRunExecutionScope: vi.fn(),
  getAgentRunIdentityPin: vi.fn(),
  getToolExecutionScopeBinding: vi.fn(),
  loadTenantAiUsageSince: vi.fn(),
  markAgentRunResuming: vi.fn(),
  planModelTurnBudget: vi.fn(),
  readAgentRunStatus: vi.fn(),
  resolveRuntimeModelAssignment: vi.fn(),
  selectAgentModel: vi.fn(),
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

vi.mock("@/lib/models/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/models/gateway")>()),
  generateModelToolTurn: mocks.generateModelToolTurn,
}));

vi.mock("@/lib/openai/model-router", () => ({
  selectAgentModel: mocks.selectAgentModel,
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
  cancelAgentRun: mocks.cancelAgentRun,
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
  markAgentRunResuming: mocks.markAgentRunResuming,
  markAgentRunWaitingForApproval: mocks.markAgentRunWaitingForApproval,
  updateRunContextCount: mocks.updateRunContextCount,
}));

vi.mock("@/lib/runs/cancellation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runs/cancellation")>()),
  createAgentRunCancellationWatch: mocks.createAgentRunCancellationWatch,
}));

vi.mock("@/lib/runs/active-run-fence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runs/active-run-fence")>()),
  readAgentRunStatus: mocks.readAgentRunStatus,
}));

vi.mock("@/lib/usage/allowance", () => ({
  loadTenantAiUsageSince: mocks.loadTenantAiUsageSince,
}));

vi.mock("@/lib/runs/budgets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runs/budgets")>();
  mocks.planModelTurnBudget.mockImplementation(actual.planModelTurnBudget);
  return { ...actual, planModelTurnBudget: mocks.planModelTurnBudget };
});

vi.mock("@/lib/settings/runtime-models", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/settings/runtime-models")>();
  mocks.resolveRuntimeModelAssignment.mockImplementation(
    actual.resolveRuntimeModelAssignment,
  );
  return {
    ...actual,
    resolveRuntimeModelAssignment: mocks.resolveRuntimeModelAssignment,
  };
});

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
    mocks.cancelAgentRun.mockResolvedValue(true);
    mocks.completeAgentRun.mockResolvedValue({ id: "run-memory-scope" });
    mocks.createAgentRunCancellationWatch.mockImplementation(
      () => cancellationWatchStub(),
    );
    mocks.readAgentRunStatus.mockResolvedValue("running");
    mocks.updateRunContextCount.mockResolvedValue(undefined);
    mocks.enqueueMemoryConsolidationJob.mockResolvedValue(null);
    mocks.getActiveAgentAdaptationGuidance.mockResolvedValue([]);
    mocks.loadProgressiveAgentTools.mockResolvedValue({ definitions: [] });
    mocks.markAgentRunWaitingForApproval.mockResolvedValue({ parked: true });
    mocks.markAgentRunResuming.mockResolvedValue(true);
    mocks.selectAgentModel.mockReturnValue({
      model: "gpt-test",
      provider: "openai",
      tier: "fast",
      reason: "Test route",
    });
    mocks.generateModelToolTurn.mockReset();
    mocks.recordRuntimeEventSafely.mockResolvedValue(undefined);
    mocks.executeGovernedTool.mockReset();
    mocks.failAgentRun.mockResolvedValue({ id: "run-memory-scope" });
    mocks.findAgentRunWaitingForToolApproval.mockReset();
    mocks.getAgentRunExecutionScope.mockResolvedValue(undefined);
    mocks.getToolExecutionScopeBinding.mockResolvedValue(undefined);
    mocks.loadTenantAiUsageSince.mockResolvedValue({
      tokens: 0,
      costMicrousd: 0,
    });
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
        outputItems: [],
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
      memoryFormation: "withheld",
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
      type: "harness",
      memoryScope: "all",
      memoryFormation: "durable",
    }));
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
      memoryFormation: "durable",
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

  it("forces approval on risk-bearing tools for a server-inferred voice command", async () => {
    const scopedRequest = request("session");
    scopedRequest.voiceOrigin = "inferred";
    scopedRequest.agentProfile!.toolIds = [
      "google.gmail.search",
      "google.gmail.trash",
    ];
    scopedRequest.agentProfile!.approvalPolicy = "risk_based";
    scopedRequest.agentProfile!.autonomy = "governed";
    mocks.loadProgressiveAgentTools.mockResolvedValue({
      definitions: [
        localToolDefinition("google.gmail.search"),
        {
          ...localToolDefinition("google.gmail.trash"),
          riskLevel: 2,
          operationClass: "mutation",
          reversible: false,
        },
      ],
    });
    mocks.executeGovernedTool.mockImplementation(async ({ toolId }) => ({
      record: localExecutionRecord(toolId, `execution-${toolId}`),
      result: { ok: true },
    }));
    let modelTurn = 0;
    mocks.streamResponseTurn.mockImplementation(async (modelRequest) => {
      modelTurn += 1;
      if (modelTurn === 1) {
        return openAITurn({
          calls: [
            { callId: "call-search", name: "google.gmail.search" },
            { callId: "call-trash", name: "google.gmail.trash" },
          ],
        });
      }
      await modelRequest.onDelta("Done.");
      return openAITurn({ text: "Done." });
    });

    await collectRequest(scopedRequest);

    expect(mocks.executeGovernedTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "google.gmail.search",
        forceApproval: false,
      }),
    );
    expect(mocks.executeGovernedTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "google.gmail.trash",
        forceApproval: true,
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
    // This Mac runs one action at a time, so every turn asks for one call.
    expect(mocks.streamResponseTurn.mock.calls.map(
      ([modelRequest]) => modelRequest.parallelToolCalls,
    )).toEqual([false, false, false]);
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
      memoryFormation: "withheld",
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
      memoryFormation: "withheld",
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
    expect(events).toContainEqual(expect.objectContaining({
      type: "harness",
      memoryFormation: "withheld",
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

  describe.each([
    ["OpenAI", "openai"],
    ["provider-bound", "google"],
  ] as const)("a %s approval resume", (_label, provider) => {
    it.each([
      ["a session-only agent", () => request("session")],
      ["a project-scoped agent", () => request("project")],
      ["a session scope on an all-memory agent", () =>
        withContextScope(request("all"), "session")],
      ["a current-turn scope on an all-memory agent", () =>
        withContextScope(request("all"), "current_turn")],
      ["a no-context scope on an all-memory agent", () =>
        withContextScope(request("all"), "none")],
      ["a shared project run", () => sharedContextRequest("project")],
      ["a shared Mission run", () => sharedContextRequest("mission")],
    ])("forms no durable memory for %s", async (_scope, build) => {
      const continuation = await pauseForApproval(build(), provider);
      expect(continuation.memoryFormation).toBe("withheld");

      await expect(resumeAfterApproval(continuation)).resolves.toMatchObject({
        resumed: true,
        status: "completed",
      });
      expect(mocks.enqueueMemoryConsolidationJob).not.toHaveBeenCalled();
    });

    it.each([
      ["an all-memory agent", () => request("all")],
      ["an agent-private scope", () =>
        withContextScope(request("all"), "agent_private")],
    ])("consolidates %s", async (_scope, build) => {
      const continuation = await pauseForApproval(build(), provider);
      expect(continuation.memoryFormation).toBe("durable");

      await expect(resumeAfterApproval(continuation)).resolves.toMatchObject({
        resumed: true,
        status: "completed",
      });
      expect(mocks.enqueueMemoryConsolidationJob).toHaveBeenCalledOnce();
    });

    it("forms no durable memory from a continuation saved without a decision", async () => {
      const { memoryFormation: _decision, ...legacy } = await pauseForApproval(
        request("all"),
        provider,
      );

      await expect(resumeAfterApproval(legacy)).resolves.toMatchObject({
        resumed: true,
        status: "completed",
      });
      expect(mocks.enqueueMemoryConsolidationJob).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["withheld", () => sharedContextRequest("project")],
    ["durable", () => request("all")],
  ] as const)(
    "keeps a %s decision when a resumed OpenAI run pauses again",
    async (decision, build) => {
      const continuation = await pauseForApproval(build(), "openai");
      mocks.markAgentRunWaitingForApproval.mockClear();
      mocks.executeGovernedTool.mockResolvedValue(approvalRequiredExecution());

      await expect(resumeAfterApproval(
        { ...continuation, maxToolSteps: 3 },
        openAITurn({
          callId: "call-memory-approval-again",
          name: APPROVAL_TOOL_ID,
        }),
      )).resolves.toMatchObject({ resumed: true, status: "waiting_approval" });

      expect(mocks.markAgentRunWaitingForApproval).toHaveBeenCalledOnce();
      expect(
        mocks.markAgentRunWaitingForApproval.mock.calls[0][1].continuation
          .memoryFormation,
      ).toBe(decision);
    },
  );

  it.each([
    ["withheld", () => sharedContextRequest("project")],
    ["durable", () => request("all")],
  ] as const)(
    "keeps a %s decision when a queued OpenAI call needs approval",
    async (decision, build) => {
      const continuation = await pauseForApproval(build(), "openai", [
        { callId: "call-memory-approval", name: APPROVAL_TOOL_ID },
        { callId: "call-memory-queued", name: APPROVAL_TOOL_ID },
      ]);
      mocks.markAgentRunWaitingForApproval.mockClear();

      await expect(resumeAfterApproval(continuation)).resolves.toMatchObject({
        resumed: true,
        status: "waiting_approval",
      });

      expect(mocks.markAgentRunWaitingForApproval).toHaveBeenCalledOnce();
      const parked = mocks.markAgentRunWaitingForApproval.mock.calls[0][1];
      expect(parked.message).toBe(
        "Run paused for the next queued function call approval.",
      );
      expect(parked.continuation.memoryFormation).toBe(decision);
    },
  );

  it.each([
    ["withheld", () => sharedContextRequest("project")],
    ["durable", () => request("all")],
  ] as const)(
    "keeps a %s decision when a resumed provider-bound run pauses again",
    async (decision, build) => {
      const continuation = await pauseForApproval(build(), "google");
      mocks.markAgentRunWaitingForApproval.mockClear();
      mocks.executeGovernedTool.mockResolvedValue(approvalRequiredExecution());

      await expect(resumeAfterApproval(
        { ...continuation, maxToolSteps: 3 },
        providerTurn({
          toolCalls: [{
            callId: "call-memory-approval-again",
            name: APPROVAL_TOOL_ID,
            argumentsJson: "{}",
          }],
        }),
      )).resolves.toMatchObject({ resumed: true, status: "waiting_approval" });

      expect(mocks.markAgentRunWaitingForApproval).toHaveBeenCalledOnce();
      expect(
        mocks.markAgentRunWaitingForApproval.mock.calls[0][1].continuation
          .memoryFormation,
      ).toBe(decision);
    },
  );

  it("streams the public grounding projection and keeps claim evidence on the run", async () => {
    const events = await collectRun("session");

    const stored = mocks.completeAgentRun.mock.calls[0]?.[2] as GroundingReport;
    expect(stored.claimEvidence).toHaveProperty("claimEvidenceMap");
    const done = events.find((event) => event.type === "done");
    expect(done).toMatchObject({ type: "done", response: "ASAEL_LIVE_OK" });
    const streamed = (done as { grounding?: GroundingReport }).grounding;
    expect(streamed).toEqual(publicGroundingReport(stored));
    expect(streamed?.claimEvidence).not.toHaveProperty("claimEvidenceMap");
  });

  describe("the final turn after the tool budget", () => {
    const REFUSED =
      "openai returned tool calls after the governed tool-step budget was exhausted.";

    function searchRequest() {
      const scopedRequest = request("session");
      scopedRequest.agentProfile!.toolIds = ["knowledge.search"];
      scopedRequest.maxToolSteps = 1;
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
      return scopedRequest;
    }

    it("keeps the tools declared on a direct OpenAI run and asks for no call", async () => {
      let modelTurn = 0;
      mocks.streamResponseTurn.mockImplementation(async (modelRequest) => {
        modelTurn += 1;
        if (modelTurn === 1) {
          return openAITurn({
            callId: "call-knowledge-search",
            name: "knowledge.search",
          });
        }
        await modelRequest.onDelta("Done.");
        return openAITurn({ text: "Done." });
      });

      const events = await collectRequest(searchRequest());

      expect(events).toContainEqual(expect.objectContaining({
        type: "done",
        response: "Done.",
      }));
      const [first, final] = mocks.streamResponseTurn.mock.calls.map(
        ([modelRequest]) => modelRequest,
      );
      expect(first.tools).toHaveLength(1);
      expect(final.tools).toEqual(first.tools);
      expect([first.toolChoice, final.toolChoice]).toEqual([undefined, "none"]);
      expect([first.parallelToolCalls, final.parallelToolCalls])
        .toEqual([undefined, undefined]);
    });

    it("fails a direct OpenAI run whose final turn still calls a tool", async () => {
      let modelTurn = 0;
      mocks.streamResponseTurn.mockImplementation(async () => {
        modelTurn += 1;
        return openAITurn({
          callId: `call-search-${modelTurn}`,
          name: "knowledge.search",
        });
      });

      const events = await collectRequest(searchRequest());

      expect(events.at(-1)).toEqual({ type: "error", message: REFUSED });
      expect(mocks.streamResponseTurn).toHaveBeenCalledTimes(2);
      expect(mocks.executeGovernedTool).toHaveBeenCalledOnce();
    });

    it("keeps the tools declared on a resumed OpenAI run's final turn", async () => {
      const continuation = await pauseForApproval(request("session"), "openai");
      const parkedTools = mocks.streamResponseTurn.mock.calls[0][0].tools;
      mocks.streamResponseTurn.mockClear();

      await expect(resumeAfterApproval({ ...continuation, maxToolSteps: 1 }))
        .resolves.toMatchObject({ resumed: true, status: "completed" });

      expect(mocks.streamResponseTurn).toHaveBeenCalledOnce();
      const resumed = mocks.streamResponseTurn.mock.calls[0][0];
      expect(parkedTools).toHaveLength(1);
      expect(resumed.tools).toEqual(parkedTools);
      expect(resumed.toolChoice).toBe("none");
      expect(resumed.parallelToolCalls).toBeUndefined();
    });

    it("asks a resumed This Mac run for one tool call per turn", async () => {
      const continuation = await pauseForApproval(request("session"), "openai");
      mocks.streamResponseTurn.mockClear();

      await expect(resumeAfterApproval({
        ...continuation,
        computerUseTarget: "local_macos",
      })).resolves.toMatchObject({ resumed: true, status: "completed" });

      expect(mocks.streamResponseTurn.mock.calls.map(
        ([modelRequest]) => modelRequest.parallelToolCalls,
      )).toEqual([false]);
    });

    it("lets a resumed OpenAI run call a tool while steps remain", async () => {
      const continuation = await pauseForApproval(request("session"), "openai");
      mocks.streamResponseTurn.mockClear();

      await expect(resumeAfterApproval({ ...continuation, maxToolSteps: 2 }))
        .resolves.toMatchObject({ resumed: true, status: "completed" });

      expect(mocks.streamResponseTurn.mock.calls[0][0].toolChoice)
        .toBeUndefined();
    });

    it("fails a resumed OpenAI run whose final turn still calls a tool", async () => {
      const continuation = await pauseForApproval(request("session"), "openai");
      const executedBefore = mocks.executeGovernedTool.mock.calls.length;
      mocks.streamResponseTurn.mockClear();

      await expect(resumeAfterApproval(
        { ...continuation, maxToolSteps: 1 },
        openAITurn({ callId: "call-after-budget", name: APPROVAL_TOOL_ID }),
      )).resolves.toMatchObject({ resumed: true, status: "failed" });

      expect(mocks.streamResponseTurn).toHaveBeenCalledOnce();
      expect(mocks.executeGovernedTool).toHaveBeenCalledTimes(executedBefore);
      expect(mocks.failAgentRun).toHaveBeenCalledWith(
        "run-memory-scope",
        REFUSED,
        expect.any(Object),
      );
    });
  });

  describe("OpenAI turn output", () => {
    /** A turn's encrypted reasoning, preamble and call, as a response returns them. */
    function returnedItems(callId: string): ConversationItem[] {
      return [
        {
          type: "reasoning",
          id: `rs-${callId}`,
          summary: [],
          encrypted_content: `encrypted-${callId}`,
        },
        {
          type: "message",
          id: `msg-${callId}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Checking.", annotations: [] }],
          phase: "commentary",
        },
        {
          type: "function_call",
          id: `item-${callId}`,
          call_id: callId,
          name: APPROVAL_TOOL_ID,
          arguments: "{}",
        },
      ];
    }

    async function pauseWithItems(callId: string) {
      const agentRequest = request("session");
      const calls = [{ callId, name: APPROVAL_TOOL_ID }];
      armApprovalPause(agentRequest, "openai", calls);
      mocks.streamResponseTurn.mockResolvedValue(openAITurn({
        calls,
        outputItems: returnedItems(callId),
      }));
      await collectRequest(agentRequest);
      return mocks.markAgentRunWaitingForApproval.mock.calls[0][1]
        .continuation as AgentRunContinuation;
    }

    it("parks a direct run with its turn's reasoning and messages", async () => {
      const continuation = await pauseWithItems("call-memory-approval");

      expect(continuation.conversationItems.slice(-3))
        .toEqual(returnedItems("call-memory-approval"));
    });

    it("sends a resumed run's items back and parks its next turn's", async () => {
      const continuation = await pauseWithItems("call-memory-approval");
      mocks.markAgentRunWaitingForApproval.mockClear();
      mocks.streamResponseTurn.mockClear();
      mocks.executeGovernedTool.mockResolvedValue(approvalRequiredExecution());

      await expect(resumeAfterApproval(
        { ...continuation, maxToolSteps: 3 },
        openAITurn({
          calls: [{ callId: "call-again", name: APPROVAL_TOOL_ID }],
          outputItems: returnedItems("call-again"),
        }),
      )).resolves.toMatchObject({ resumed: true, status: "waiting_approval" });

      expect(mocks.streamResponseTurn.mock.calls[0][0].input.slice(-4)).toEqual([
        ...returnedItems("call-memory-approval"),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call-memory-approval",
        }),
      ]);
      expect(
        mocks.markAgentRunWaitingForApproval.mock.calls[0][1].continuation
          .conversationItems.slice(-3),
      ).toEqual(returnedItems("call-again"));
    });
  });

  describe("model turn budgets", () => {
    // Every fixture turn reports 7 tokens, far below its estimate.
    const WORKSPACE_EXHAUSTED =
      /^The workspace's token budget for the last 24 hours is exhausted \(\d+ requested, limit \d+\)\./;

    it.each(["openai", "google"] as const)(
      "charges a %s turn what it spent, not its estimate",
      async (provider) => {
        const continuation = await pauseForApproval(request("session"), provider);

        expect(continuation.budgetState?.used).toMatchObject({
          modelTurns: 1,
          tokens: 7,
          retries: 0,
        });
      },
    );

    it.each(["openai", "google"] as const)(
      "charges a %s turn its input and output when they exceed its reported total",
      async (provider) => {
        const agentRequest = request("session");
        armApprovalPause(agentRequest, provider);
        const call = { callId: "call-memory-approval", name: APPROVAL_TOOL_ID };
        const usage = {
          inputTokens: 40,
          outputTokens: 10,
          cachedInputTokens: 0,
          totalTokens: 0,
        };
        if (provider === "google") {
          mocks.generateModelToolTurn.mockResolvedValue({
            ...providerTurn({ toolCalls: [{ ...call, argumentsJson: "{}" }] }),
            usage,
          });
        } else {
          mocks.streamResponseTurn.mockResolvedValue({
            ...openAITurn({ calls: [call] }),
            usage,
          });
        }

        await collectRequest(agentRequest);

        const parked = mocks.markAgentRunWaitingForApproval.mock.calls[0][1]
          .continuation as AgentRunContinuation;
        expect(parked.budgetState?.used.tokens).toBe(50);
      },
    );

    it("reserves a turn's input and most output, and the next turn's after a full round of tool results", async () => {
      const events = await collectRequest(request("session"));

      expect(events).toContainEqual(expect.objectContaining({ type: "done" }));
      const [modelRequest] = mocks.streamResponseTurn.mock.calls[0];
      const inputTokens = estimateModelInputTokens([
        modelRequest.instructions,
        modelRequest.input,
        modelRequest.tools,
      ]);
      // The most output is mocked to 128 tokens; five results of 8,000
      // characters are 10,000 tokens.
      expect(mocks.planModelTurnBudget.mock.calls[0]?.[1].estimate).toMatchObject({
        tokens: inputTokens + 128,
        followUpTokens: inputTokens + 128 + 10_000 + 128,
      });
    });

    it.each(["openai", "google"] as const)(
      "charges a resumed %s turn what it spent",
      async (provider) => {
        const continuation = await pauseForApproval(request("session"), provider);
        mocks.markAgentRunWaitingForApproval.mockClear();
        const call = { callId: "call-second-approval", name: APPROVAL_TOOL_ID };

        await expect(resumeAfterApproval(
          { ...continuation, maxToolSteps: 3 },
          provider === "openai"
            ? openAITurn({ calls: [call] })
            : providerTurn({ toolCalls: [{ ...call, argumentsJson: "{}" }] }),
        )).resolves.toMatchObject({ resumed: true, status: "waiting_approval" });

        const parked = mocks.markAgentRunWaitingForApproval.mock.calls[0][1]
          .continuation as AgentRunContinuation;
        expect(parked.budgetState?.used).toMatchObject({
          modelTurns: 2,
          tokens: 14,
          retries: 0,
        });
      },
    );

    it("asks a direct OpenAI run for its answer when no turn would follow its tools", async () => {
      const scopedRequest = request("session");
      scopedRequest.agentProfile!.toolIds = ["knowledge.search"];
      scopedRequest.budgetLimits = {
        ...DEFAULT_AGENT_RUN_BUDGET_LIMITS,
        modelTurns: 1,
      };
      mocks.loadProgressiveAgentTools.mockResolvedValue({
        definitions: [localToolDefinition("knowledge.search")],
      });
      mocks.streamResponseTurn.mockImplementation(async (modelRequest) => {
        await modelRequest.onDelta("Answered within budget.");
        return openAITurn({ text: "Answered within budget." });
      });

      const events = await collectRequest(scopedRequest);

      expect(mocks.streamResponseTurn).toHaveBeenCalledOnce();
      const [modelRequest] = mocks.streamResponseTurn.mock.calls[0];
      expect(modelRequest.tools).toHaveLength(1);
      expect(modelRequest.toolChoice).toBe("none");
      expect(events).toContainEqual(expect.objectContaining({
        type: "status",
        label: "finishing within budget",
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "done",
        response: "Answered within budget.",
      }));
    });

    it("asks a resumed OpenAI run for its answer when no turn would follow its tools", async () => {
      const continuation = await pauseForApproval(request("session"), "openai");
      mocks.streamResponseTurn.mockClear();
      mocks.appendRunEvent.mockClear();
      const budgetState = continuation.budgetState!;

      await expect(resumeAfterApproval({
        ...continuation,
        maxToolSteps: 3,
        budgetState: {
          ...budgetState,
          limits: {
            ...budgetState.limits,
            modelTurns: budgetState.used.modelTurns + 1,
          },
        },
      })).resolves.toMatchObject({ resumed: true, status: "completed" });

      expect(mocks.streamResponseTurn).toHaveBeenCalledOnce();
      expect(mocks.streamResponseTurn.mock.calls[0][0].toolChoice).toBe("none");
      expect(mocks.appendRunEvent.mock.calls.map(([, event]) => event))
        .toContainEqual(expect.objectContaining({
          type: "status",
          label: "finishing within budget",
        }));
    });

    it("stops a run before its first turn once the workspace's daily tokens are spent", async () => {
      mocks.loadTenantAiUsageSince.mockResolvedValue({
        tokens: TENANT_DAILY_MAX_TOKENS,
        costMicrousd: 0,
      });
      const before = Date.now();

      const events = await collectRequest(request("session"));

      expect(mocks.streamResponseTurn).not.toHaveBeenCalled();
      expect(mocks.loadTenantAiUsageSince).toHaveBeenCalledOnce();
      const [{ tenantId, since }] = mocks.loadTenantAiUsageSince.mock.calls[0];
      expect(tenantId).toBe("paid-test-tenant");
      expect(before - since.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1_000 - 5_000);
      expect(before - since.getTime()).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
      expect(events).toContainEqual(expect.objectContaining({
        type: "budget_exhausted",
        dimension: "tokens",
        limit: TENANT_DAILY_MAX_TOKENS,
        message: expect.stringMatching(WORKSPACE_EXHAUSTED),
      }));
      expect(events.at(-1)).toEqual({
        type: "error",
        message: expect.stringMatching(WORKSPACE_EXHAUSTED),
      });
    });

    it("stops a resumed run once the workspace's daily tokens are spent", async () => {
      const continuation = await pauseForApproval(request("session"), "google");
      mocks.generateModelToolTurn.mockClear();
      mocks.loadTenantAiUsageSince.mockResolvedValue({
        tokens: TENANT_DAILY_MAX_TOKENS,
        costMicrousd: 0,
      });

      await expect(resumeAfterApproval(continuation))
        .resolves.toMatchObject({ resumed: true, status: "failed" });

      expect(mocks.generateModelToolTurn).not.toHaveBeenCalled();
      expect(mocks.failAgentRun).toHaveBeenCalledWith(
        "run-memory-scope",
        expect.stringMatching(WORKSPACE_EXHAUSTED),
        expect.any(Object),
      );
    });

    it("keeps to the run's own limits when the workspace's usage cannot be read", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      mocks.loadTenantAiUsageSince.mockRejectedValue(new Error("ledger offline"));

      try {
        const events = await collectRequest(request("session"));

        expect(events).toContainEqual(expect.objectContaining({
          type: "done",
          response: "ASAEL_LIVE_OK",
        }));
        expect(warn).toHaveBeenCalledWith(
          "The workspace's AI usage for the last 24 hours could not be read; the run's own limits still apply.",
          "ledger offline",
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("adds what a run spends after the window was read to the workspace's usage", async () => {
      mocks.loadTenantAiUsageSince.mockResolvedValue({ tokens: 1_000, costMicrousd: 0 });
      const scopedRequest = request("session");
      scopedRequest.agentProfile!.toolIds = ["knowledge.search"];
      mocks.loadProgressiveAgentTools.mockResolvedValue({
        definitions: [localToolDefinition("knowledge.search")],
      });
      mocks.executeGovernedTool.mockResolvedValue({
        record: localExecutionRecord("knowledge.search", "execution-knowledge-search"),
        result: { results: [] },
      });
      mocks.streamResponseTurn.mockImplementation(async (modelRequest) => {
        if (mocks.streamResponseTurn.mock.calls.length === 1) {
          return openAITurn({ callId: "call-knowledge-search", name: "knowledge.search" });
        }
        await modelRequest.onDelta("Done.");
        return openAITurn({ text: "Done." });
      });

      const events = await collectRequest(scopedRequest);

      expect(events).toContainEqual(expect.objectContaining({ type: "done", response: "Done." }));
      expect(mocks.loadTenantAiUsageSince).toHaveBeenCalledOnce();
      expect(mocks.planModelTurnBudget.mock.calls.map(([, plan]) => plan.ceiling?.tokens))
        .toEqual([
          { limit: TENANT_DAILY_MAX_TOKENS, used: 1_000 },
          { limit: TENANT_DAILY_MAX_TOKENS, used: 1_007 },
        ]);
    });

    it("does not add a resumed run's earlier usage to the window that already counts it", async () => {
      const continuation = await pauseForApproval(request("session"), "openai");
      expect(continuation.budgetState?.used.tokens).toBe(7);
      mocks.loadTenantAiUsageSince.mockResolvedValue({ tokens: 1_000, costMicrousd: 0 });
      mocks.planModelTurnBudget.mockClear();

      await expect(resumeAfterApproval({ ...continuation, maxToolSteps: 3 }))
        .resolves.toMatchObject({ resumed: true, status: "completed" });

      expect(mocks.planModelTurnBudget.mock.calls[0]?.[1].ceiling?.tokens).toEqual({
        limit: TENANT_DAILY_MAX_TOKENS,
        used: 1_000,
      });
    });
  });

  describe("run cancellation", () => {
    const STOPPED_RESUME = {
      resumed: false,
      reason: "The run was canceled or finalized before the resumed work finished.",
    };

    it("stops without finalizing once another request cancels the run mid-tool", async () => {
      const watch = cancellationWatchStub();
      mocks.createAgentRunCancellationWatch.mockReturnValue(watch);
      const scopedRequest = request("session");
      scopedRequest.agentProfile!.toolIds = ["knowledge.search"];
      mocks.loadProgressiveAgentTools.mockResolvedValue({
        definitions: [localToolDefinition("knowledge.search")],
      });
      mocks.executeGovernedTool.mockImplementation(async () => {
        watch.cancel();
        return {
          record: localExecutionRecord(
            "knowledge.search",
            "execution-knowledge-search",
          ),
          result: { results: [] },
        };
      });
      mocks.streamResponseTurn.mockImplementation(async (modelRequest) => {
        if (mocks.streamResponseTurn.mock.calls.length === 1) {
          return openAITurn({
            callId: "call-knowledge-search",
            name: "knowledge.search",
          });
        }
        await modelRequest.onDelta("Done.");
        return openAITurn({ text: "Done." });
      });

      const events = await collectRequest(scopedRequest);

      expect(events.at(-1)).toEqual({
        type: "canceled",
        message: "Agent run stopped because it was canceled.",
      });
      expect(mocks.streamResponseTurn).toHaveBeenCalledOnce();
      expect(
        mocks.executeGovernedTool.mock.calls[0][0].abortSignal.aborted,
      ).toBe(true);
      expect(mocks.completeAgentRun).not.toHaveBeenCalled();
      expect(mocks.failAgentRun).not.toHaveBeenCalled();
      expect(mocks.cancelAgentRun).not.toHaveBeenCalled();
      expect(watch.watch).toHaveBeenCalledWith({
        runId: "run-memory-scope",
        tenantId: "paid-test-tenant",
      });
      expect(watch.stop).toHaveBeenCalledOnce();
    });

    it("stops watching when the caller abandons the stream", async () => {
      const watch = cancellationWatchStub();
      mocks.createAgentRunCancellationWatch.mockReturnValue(watch);
      const stream = runAgent(request("session"));

      await stream.next();
      await stream.return(undefined);

      expect(watch.stop).toHaveBeenCalledOnce();
    });

    it.each(["openai", "google"] as const)(
      "stops a %s run quietly when a cancel beats its approval pause",
      async (provider) => {
        const agentRequest = request("session");
        armApprovalPause(agentRequest, provider);
        mocks.markAgentRunWaitingForApproval.mockResolvedValue({ parked: false });
        mocks.readAgentRunStatus.mockResolvedValue("canceled");

        const events = await collectRequest(agentRequest);

        expect(events.at(-1)).toEqual({
          type: "canceled",
          message: "Agent run stopped because it was canceled.",
        });
        expect(events.map((event) => event.type)).not.toContain(
          "waiting_approval",
        );
        expect(mocks.readAgentRunStatus).toHaveBeenCalledWith({
          runId: "run-memory-scope",
          tenantId: "paid-test-tenant",
        });
        expect(mocks.failAgentRun).not.toHaveBeenCalled();
        expect(mocks.completeAgentRun).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["completed", "completed"],
      ["failed", "failed"],
      ["deleted", undefined],
    ] as const)(
      "stops quietly when the run was %s before its approval pause",
      async (_label, runStatus) => {
        const agentRequest = request("session");
        armApprovalPause(agentRequest, "openai");
        mocks.markAgentRunWaitingForApproval.mockResolvedValue({ parked: false });
        mocks.readAgentRunStatus.mockResolvedValue(runStatus);

        const events = await collectRequest(agentRequest);

        expect(events.at(-1)).toEqual({
          type: "error",
          message: "Agent run stopped because it is no longer active.",
        });
        expect(mocks.failAgentRun).not.toHaveBeenCalled();
        expect(mocks.completeAgentRun).not.toHaveBeenCalled();
      },
    );

    it("fails a run whose approval pause is refused while it is still active", async () => {
      const agentRequest = request("session");
      armApprovalPause(agentRequest, "openai");
      mocks.markAgentRunWaitingForApproval.mockResolvedValue({ parked: false });
      mocks.readAgentRunStatus.mockResolvedValue("waiting_clarification");
      const message =
        "Agent run run-memory-scope could not pause for approval while waiting_clarification.";

      const events = await collectRequest(agentRequest);

      expect(events.at(-1)).toEqual({ type: "error", message });
      expect(mocks.failAgentRun).toHaveBeenCalledWith(
        "run-memory-scope",
        message,
        expect.objectContaining({ tenantId: "paid-test-tenant" }),
      );
    });

    it("stops a resumed OpenAI run that is canceled while its next tool runs", async () => {
      const continuation = await pauseForApproval(request("session"), "openai");
      const watch = cancellationWatchStub();
      mocks.createAgentRunCancellationWatch.mockReturnValue(watch);
      mocks.streamResponseTurn.mockClear();
      mocks.executeGovernedTool.mockImplementation(async () => {
        watch.cancel();
        return {
          record: localExecutionRecord(APPROVAL_TOOL_ID, "execution-after-resume"),
          result: { ok: true },
        };
      });

      await expect(resumeAfterApproval(
        { ...continuation, maxToolSteps: 3 },
        openAITurn({ callId: "call-after-resume", name: APPROVAL_TOOL_ID }),
      )).resolves.toEqual(STOPPED_RESUME);

      expect(mocks.streamResponseTurn).toHaveBeenCalledOnce();
      expect(mocks.failAgentRun).not.toHaveBeenCalled();
      expect(mocks.completeAgentRun).not.toHaveBeenCalled();
      expect(watch.watch).toHaveBeenCalledWith({
        runId: "run-memory-scope",
        tenantId: "paid-test-tenant",
      });
      expect(watch.stop).toHaveBeenCalledOnce();
    });

    it("stops a resumed OpenAI run whose model turn is aborted by a cancel", async () => {
      const continuation = await pauseForApproval(request("session"), "openai");
      const watch = cancellationWatchStub();
      mocks.createAgentRunCancellationWatch.mockReturnValue(watch);
      mocks.streamResponseTurn.mockClear();
      mocks.streamResponseTurn.mockImplementationOnce(async (modelRequest) => {
        watch.cancel();
        modelRequest.abortSignal?.throwIfAborted();
        return openAITurn({ text: "Done." });
      });

      await expect(resumeAfterApproval(continuation)).resolves.toEqual(
        STOPPED_RESUME,
      );

      expect(mocks.failAgentRun).not.toHaveBeenCalled();
      expect(mocks.completeAgentRun).not.toHaveBeenCalled();
    });

    it("stops a resumed provider-bound run whose model turn is aborted by a cancel", async () => {
      const continuation = await pauseForApproval(request("session"), "google");
      const watch = cancellationWatchStub();
      mocks.createAgentRunCancellationWatch.mockReturnValue(watch);
      mocks.generateModelToolTurn.mockImplementationOnce(async (modelRequest) => {
        watch.cancel();
        modelRequest.abortSignal?.throwIfAborted();
        return providerTurn({ text: "Done." });
      });

      await expect(resumeAfterApproval(continuation)).resolves.toEqual(
        STOPPED_RESUME,
      );

      expect(mocks.failAgentRun).not.toHaveBeenCalled();
      expect(mocks.completeAgentRun).not.toHaveBeenCalled();
      expect(watch.stop).toHaveBeenCalledOnce();
    });
  });

  describe("workspace model routes that cannot be used", () => {
    const BLOCKED_ROUTE = {
      outcome: "blocked",
      code: "connection_unavailable",
      message:
        "The assigned provider does not have an enabled, validated workspace connection, so no model was called. Reconnect the provider in Settings, then try again.",
    } as const;
    const DEPLOYMENT_ROUTE = {
      outcome: "deployment_environment",
      code: "connection_unavailable",
      message:
        "The assigned provider does not have an enabled, validated workspace connection, so deployment-environment routing remains in effect.",
    } as const;

    /** A route Settings could not supply and the deployment may not replace. */
    function blockedRoute(): RuntimeModelResolution {
      return {
        scope: "main_agent",
        source: "tenant_assignment",
        configured: false,
        degradation: BLOCKED_ROUTE,
        allowCrossProviderFallback: false,
        warnings: [BLOCKED_ROUTE.message],
        reason: BLOCKED_ROUTE.message,
        usageReceipt: { assignmentScope: "main_agent" },
        bind: (modelRequest) => modelRequest,
        withProviderApiKey: async () => {
          throw new ModelRouteUnavailableError(BLOCKED_ROUTE);
        },
      };
    }

    /** The resolver's own deployment route, marked as standing in for the workspace's. */
    function degradeNextRouteToDeployment() {
      mocks.resolveRuntimeModelAssignment.mockImplementationOnce(async (input) => {
        const actual = await vi.importActual<
          typeof import("@/lib/settings/runtime-models")
        >("@/lib/settings/runtime-models");
        return {
          ...(await actual.resolveRuntimeModelAssignment(input)),
          degradation: DEPLOYMENT_ROUTE,
        };
      });
    }

    it("stops a run before any model is called and says why", async () => {
      mocks.resolveRuntimeModelAssignment.mockResolvedValueOnce(blockedRoute());

      const events = await collectRequest(request("session"));

      const degradedAt = events.findIndex((event) =>
        event.type === "model_route_degraded"
      );
      expect(events[degradedAt]).toEqual({
        type: "model_route_degraded",
        ...BLOCKED_ROUTE,
      });
      expect(events.slice(degradedAt + 1)).toEqual([
        { type: "error", message: BLOCKED_ROUTE.message },
      ]);
      expect(mocks.appendRunEvent).toHaveBeenCalledWith(
        "run-memory-scope",
        { type: "model_route_degraded", ...BLOCKED_ROUTE },
        expect.any(Object),
      );
      expect(mocks.failAgentRun).toHaveBeenCalledWith(
        "run-memory-scope",
        BLOCKED_ROUTE.message,
        expect.any(Object),
      );
      expect(mocks.streamResponseTurn).not.toHaveBeenCalled();
      expect(mocks.generateModelToolTurn).not.toHaveBeenCalled();
    });

    it("records a route the deployment's models stood in for, and still answers", async () => {
      degradeNextRouteToDeployment();

      const events = await collectRequest(request("session"));

      expect(events).toContainEqual({
        type: "model_route_degraded",
        ...DEPLOYMENT_ROUTE,
      });
      expect(events.at(-1)).toMatchObject({ type: "done" });
      expect(mocks.streamResponseTurn).toHaveBeenCalledOnce();
      expect(mocks.failAgentRun).not.toHaveBeenCalled();
    });

    it.each(["openai", "google"] as const)(
      "fails a resumed %s run whose route can no longer be used, without claiming it",
      async (provider) => {
        const continuation = await pauseForApproval(request("session"), provider);
        mocks.streamResponseTurn.mockClear();
        mocks.generateModelToolTurn.mockClear();
        mocks.markAgentRunResuming.mockClear();
        mocks.resolveRuntimeModelAssignment.mockClear()
          .mockResolvedValueOnce(blockedRoute());

        await expect(resumeAfterApproval(continuation)).resolves.toEqual({
          resumed: false,
          reason: BLOCKED_ROUTE.message,
        });

        expect(mocks.resolveRuntimeModelAssignment).toHaveBeenCalledOnce();
        expect(mocks.markAgentRunResuming).not.toHaveBeenCalled();
        expect(mocks.failAgentRun).toHaveBeenCalledWith(
          "run-memory-scope",
          BLOCKED_ROUTE.message,
          expect.any(Object),
        );
        expect(mocks.streamResponseTurn).not.toHaveBeenCalled();
        expect(mocks.generateModelToolTurn).not.toHaveBeenCalled();
      },
    );

    it.each(["openai", "google"] as const)(
      "records a resumed %s run's stand-in route once it claims the run",
      async (provider) => {
        const continuation = await pauseForApproval(request("session"), provider);
        mocks.appendRunEvent.mockClear();
        mocks.markAgentRunResuming.mockClear();
        mocks.resolveRuntimeModelAssignment.mockClear();
        degradeNextRouteToDeployment();

        await expect(resumeAfterApproval(continuation))
          .resolves.toMatchObject({ resumed: true, status: "completed" });

        expect(mocks.resolveRuntimeModelAssignment).toHaveBeenCalledOnce();
        const degradedCall = mocks.appendRunEvent.mock.calls.findIndex(
          ([, event]) => event?.type === "model_route_degraded",
        );
        expect(mocks.appendRunEvent.mock.calls[degradedCall]).toEqual([
          "run-memory-scope",
          { type: "model_route_degraded", ...DEPLOYMENT_ROUTE },
          expect.any(Object),
        ]);
        expect(mocks.appendRunEvent.mock.invocationCallOrder[degradedCall])
          .toBeGreaterThan(mocks.markAgentRunResuming.mock.invocationCallOrder[0]);
      },
    );
  });
});

const APPROVAL_TOOL_ID = "google.gmail.trash";
const APPROVAL_EXECUTION_ID = "execution-memory-approval";

function withContextScope(
  agentRequest: AgentRunRequest,
  contextScope: NonNullable<AgentRunRequest["contextScope"]>,
) {
  agentRequest.contextScope = contextScope;
  return agentRequest;
}

function sharedContextRequest(contextScope: "project" | "mission") {
  const scopedRequest = request("all");
  scopedRequest.actorId = privateOwnerContext.actorId;
  scopedRequest.contextScope = contextScope;
  scopedRequest.executionScope = createExecutionScope({
    tenantId: privateOwnerContext.tenantId,
    initiatingActorId: privateOwnerContext.actorId,
    executingPrincipalType: "agent",
    executingPrincipalId: "paid-test-agent",
    workspaceId: "workspace:team-a",
    projectId: "project:launch",
    ...(contextScope === "mission" ? { missionId: "legacy-project-a" } : {}),
    correlationId: "project-context-request",
    purpose: "agent.run",
  });
  scopedRequest.promptSharedMemoryAccess = sharedProjectAccess();
  return scopedRequest;
}

function approvalRequiredExecution() {
  return {
    record: {
      ...localExecutionRecord(APPROVAL_TOOL_ID, APPROVAL_EXECUTION_ID),
      riskLevel: 2 as const,
      status: "approval_required" as const,
      approvalRequired: true,
    },
  };
}

/** Runs one request until its first governed tool call parks for approval. */
async function pauseForApproval(
  agentRequest: AgentRunRequest,
  provider: "openai" | "google",
  calls: readonly { callId: string; name: string }[] = [
    { callId: "call-memory-approval", name: APPROVAL_TOOL_ID },
  ],
): Promise<AgentRunContinuation> {
  armApprovalPause(agentRequest, provider, calls);

  const events = await collectRequest(agentRequest);

  expect(events).toContainEqual(expect.objectContaining({
    type: "waiting_approval",
    executionId: APPROVAL_EXECUTION_ID,
  }));
  expect(Boolean(
    mocks.markAgentRunWaitingForApproval.mock.calls[0]?.[1]?.continuation
      ?.providerToolState,
  )).toBe(provider === "google");
  return mocks.markAgentRunWaitingForApproval.mock.calls[0][1].continuation;
}

/** Makes the request's first governed tool call require an approval. */
function armApprovalPause(
  agentRequest: AgentRunRequest,
  provider: "openai" | "google",
  calls: readonly { callId: string; name: string }[] = [
    { callId: "call-memory-approval", name: APPROVAL_TOOL_ID },
  ],
) {
  agentRequest.agentProfile!.toolIds = [APPROVAL_TOOL_ID];
  agentRequest.agentProfile!.approvalPolicy = "risk_based";
  agentRequest.agentProfile!.autonomy = "governed";
  mocks.loadProgressiveAgentTools.mockResolvedValue({
    definitions: [{
      ...localToolDefinition(APPROVAL_TOOL_ID),
      riskLevel: 2,
      approvalRequired: true,
      operationClass: "mutation",
      reversible: false,
    }],
  });
  mocks.executeGovernedTool.mockResolvedValue(approvalRequiredExecution());
  if (provider === "google") {
    mocks.selectAgentModel.mockReturnValue({
      model: "gemini-test",
      provider: "google",
      tier: "fast",
      reason: "Test route",
    });
    mocks.generateModelToolTurn.mockResolvedValue(providerTurn({
      toolCalls: calls.map((call) => ({ ...call, argumentsJson: "{}" })),
    }));
  } else {
    mocks.streamResponseTurn.mockResolvedValue(openAITurn({ calls }));
  }
}

/** Resumes a parked run after its tool executed, with the next model turn. */
async function resumeAfterApproval(
  continuation: AgentRunContinuation,
  nextTurn?: ReturnType<typeof openAITurn> | ModelToolTurnResult,
) {
  const governedCall = mocks.executeGovernedTool.mock.calls[0]?.[0];
  mocks.enqueueMemoryConsolidationJob.mockClear();
  mocks.findAgentRunWaitingForToolApproval.mockResolvedValue({
    id: "run-memory-scope",
    tenantId: "paid-test-tenant",
    ownerActorId: continuation.context.actorId,
    agentId: "paid-test-agent",
    mode: "orchestrate",
    status: "waiting_approval",
    prompt: "hello",
    messages: [{ role: "user", content: "hello" }],
    memoryContextCount: 0,
    startedAt: "2026-09-26T00:00:00.000Z",
    continuation,
  });
  mocks.getAgentRunExecutionScope.mockResolvedValue(
    continuation.executionScope,
  );
  mocks.getToolExecutionScopeBinding.mockResolvedValue(
    governedCall?.executionScope
      ? { executionScope: governedCall.executionScope }
      : undefined,
  );
  if (continuation.providerToolState) {
    mocks.generateModelToolTurn.mockResolvedValue(
      nextTurn || providerTurn({ text: "Done." }),
    );
  } else {
    mocks.streamResponseTurn.mockImplementation(async (modelRequest) => {
      if (nextTurn) return nextTurn;
      await modelRequest.onDelta("Done.");
      return openAITurn({ text: "Done." });
    });
  }
  return resumeAgentRunAfterToolApproval({
    executionId: APPROVAL_EXECUTION_ID,
    tenantId: "paid-test-tenant",
    toolExecution: {
      record: {
        ...localExecutionRecord(APPROVAL_TOOL_ID, APPROVAL_EXECUTION_ID),
        tenantId: "paid-test-tenant",
        riskLevel: 2,
        approvalRequired: true,
      },
      result: { ok: true },
    },
  });
}

/** A cancellation watch the test cancels by hand. It never polls. */
function cancellationWatchStub() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    watch: vi.fn(),
    stop: vi.fn(),
    cancel() {
      controller.abort(
        new AgentRunTerminatedError("run-memory-scope", "canceled"),
      );
    },
  };
}

function providerTurn(input: {
  text?: string;
  toolCalls?: ModelToolCall[];
}): ModelToolTurnResult {
  return {
    text: input.text || "",
    toolCalls: input.toolCalls || [],
    continuation: { provider: "google", state: [] },
    provider: "google",
    model: "gemini-test",
    usage: {
      inputTokens: 5,
      outputTokens: 2,
      cachedInputTokens: 0,
      totalTokens: 7,
    },
    latencyMs: 1,
    costKnown: false,
    attempts: [{
      provider: "google",
      model: "gemini-test",
      status: "completed",
      latencyMs: 1,
    }],
  };
}

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
  /** The items the response returned, when a test sets them. */
  outputItems?: ConversationItem[];
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
    outputItems: input.outputItems ?? [
      ...(input.text
        ? [{
            type: "message" as const,
            role: "assistant" as const,
            content: input.text,
          }]
        : []),
      ...functionCalls.map((call) => ({
        type: "function_call" as const,
        id: `item-${call.callId}`,
        call_id: call.callId,
        name: call.name,
        arguments: call.argumentsJson,
      })),
    ],
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
