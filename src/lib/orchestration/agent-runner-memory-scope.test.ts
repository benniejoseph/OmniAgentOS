import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentPromptMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import { personalContextMemoryAccessFromSecurityContext } from "@/lib/memory/personal-context-access";
import { buildPersonalContextConsentAuthorityV1 } from "@/lib/memory/personal-context-consent";
import type { RequestSharedMemoryAccessV1 } from "@/lib/memory/shared-context";
import { runAgent } from "@/lib/orchestration/agent-runner";
import type { AgentEvent, AgentRunRequest } from "@/lib/orchestration/types";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import { AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES } from "@/lib/rag/context-engine";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { sourceContractSha256 } from "@/lib/sources/contracts";

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
  recordRuntimeEventSafely: vi.fn(),
  resolvePersonalContextMemoryAccess: vi.fn(),
  runCouncilRound: vi.fn(),
  streamResponseTurn: vi.fn(),
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

vi.mock("@/lib/capabilities/toolbox", () => ({
  capabilityFunctionName: (id: string) => id,
  loadProgressiveAgentTools: mocks.loadProgressiveAgentTools,
}));

vi.mock("@/lib/models/registry", () => ({
  hasModelProviderFeature: (feature: string) =>
    feature === "text" || feature === "json_schema",
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
  failAgentRun: vi.fn(),
  findAgentRunWaitingForToolApproval: vi.fn(),
  getAgentRun: vi.fn(),
  listAgentRunSummaries: vi.fn(),
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
    mocks.recordRuntimeEventSafely.mockResolvedValue(undefined);
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
      contextRationale: [
        "The user limited this run to the current conversation.",
      ],
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
