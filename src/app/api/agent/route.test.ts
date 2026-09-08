import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
  appendThreadTurn: vi.fn(),
  authorizeRequest: vi.fn(),
  checkSharedRateLimit: vi.fn(),
  attachMissionExecutor: vi.fn(),
  createThread: vi.fn(),
  createMission: vi.fn(),
  ensureMissionTask: vi.fn(),
  getAgentPerformance: vi.fn(),
  getOwnedProject: vi.fn(),
  getMission: vi.fn(),
  getThread: vi.fn(),
  resolveAgentIdentityForExecution: vi.fn(),
  listConversationSummaries: vi.fn(),
  listThreadTurns: vi.fn(),
  resolveLoopV2ContextTextEnrollment: vi.fn(),
  resolveLoopV2ModelTextEnrollment: vi.fn(),
  resolveLoopV2ReadOnlyCanaryEnrollment: vi.fn(),
  requestSharedMemoryAccessFromSecurityContext: vi.fn(),
  personalContextMemoryAccessFromSecurityContext: vi.fn(),
  requireActivePersonalContextConsent: vi.fn(),
  resolveSemanticIntent: vi.fn(),
  runAgent: vi.fn(),
  runLoopV2ModelText: vi.fn(),
  runLoopV2ReadOnlyCanary: vi.fn(),
  syncMissionExecutor: vi.fn(),
  transitionMission: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/http/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http/rate-limit")>()),
  checkSharedRateLimit: routeMocks.checkSharedRateLimit,
}));

vi.mock("@/lib/agents/performance", () => ({
  getAgentPerformance: routeMocks.getAgentPerformance,
}));

vi.mock("@/lib/agents/identity-store", () => ({
  AgentIdentityResolutionError: class AgentIdentityResolutionError extends Error {},
  resolveAgentIdentityForExecution:
    routeMocks.resolveAgentIdentityForExecution,
}));

vi.mock("@/lib/projects/store", () => ({
  getOwnedProject: routeMocks.getOwnedProject,
}));

vi.mock("@/lib/missions/store", () => ({
  createMission: routeMocks.createMission,
  ensureMissionTask: routeMocks.ensureMissionTask,
  getMission: routeMocks.getMission,
  transitionMission: routeMocks.transitionMission,
}));

vi.mock("@/lib/missions/runtime", () => ({
  attachMissionExecutor: routeMocks.attachMissionExecutor,
  syncMissionExecutor: routeMocks.syncMissionExecutor,
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: routeMocks.appendScopedDomainEvent,
}));

vi.mock("@/lib/threads/store", () => ({
  appendThreadTurn: routeMocks.appendThreadTurn,
  createThread: routeMocks.createThread,
  getThread: routeMocks.getThread,
  listConversationSummaries: routeMocks.listConversationSummaries,
  listThreadTurns: routeMocks.listThreadTurns,
}));

vi.mock("@/lib/orchestration/agent-runner", () => ({
  runAgent: routeMocks.runAgent,
}));

vi.mock("@/lib/orchestration/loop-v2-runtime", () => ({
  resolveLoopV2ReadOnlyCanaryEnrollment:
    routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment,
  runLoopV2ReadOnlyCanary: routeMocks.runLoopV2ReadOnlyCanary,
}));

vi.mock("@/lib/orchestration/loop-v2-model-text-runtime", () => ({
  resolveLoopV2ContextTextEnrollment:
    routeMocks.resolveLoopV2ContextTextEnrollment,
  resolveLoopV2ModelTextEnrollment:
    routeMocks.resolveLoopV2ModelTextEnrollment,
  runLoopV2ModelText: routeMocks.runLoopV2ModelText,
}));

vi.mock("@/lib/orchestration/semantic-intent-resolver", () => ({
  resolveSemanticIntent: routeMocks.resolveSemanticIntent,
}));

vi.mock("@/lib/memory/shared-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/shared-context")>()),
  requestSharedMemoryAccessFromSecurityContext:
    routeMocks.requestSharedMemoryAccessFromSecurityContext,
}));

vi.mock("@/lib/memory/personal-context-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/personal-context-access")>()),
  personalContextMemoryAccessFromSecurityContext:
    routeMocks.personalContextMemoryAccessFromSecurityContext,
}));

vi.mock("@/lib/memory/personal-context-consent-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/personal-context-consent-store")>()),
  requireActivePersonalContextConsent:
    routeMocks.requireActivePersonalContextConsent,
}));

import { POST } from "@/app/api/agent/route";

const context = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "actor-a@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};

beforeEach(() => {
  vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "agent-route-context-lock-test-secret");
  routeMocks.appendScopedDomainEvent.mockReset().mockResolvedValue(undefined);
  routeMocks.appendThreadTurn.mockReset()
    .mockResolvedValueOnce({ id: "turn-user" })
    .mockResolvedValueOnce({ id: "turn-assistant" });
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.checkSharedRateLimit.mockReset().mockResolvedValue({ allowed: true });
  routeMocks.attachMissionExecutor.mockReset().mockResolvedValue(undefined);
  routeMocks.createMission.mockReset();
  routeMocks.createThread.mockReset().mockResolvedValue({
    id: "thread-a",
    tenantId: context.tenantId,
    actorId: context.actorId,
  });
  routeMocks.getAgentPerformance.mockReset().mockResolvedValue([]);
  routeMocks.ensureMissionTask.mockReset().mockResolvedValue({
    id: "mission-task-a",
    status: "pending",
  });
  routeMocks.getMission.mockReset().mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    title: "Launch mission",
    objective: "Ship the launch",
    priority: "normal",
    status: "queued",
  });
  routeMocks.getOwnedProject.mockReset().mockResolvedValue({
    id: "project-a",
    tenantId: context.tenantId,
    actorId: context.actorId,
  });
  routeMocks.getThread.mockReset().mockResolvedValue(null);
  routeMocks.resolveAgentIdentityForExecution.mockReset().mockResolvedValue({
    definition: {
      logicalAgentId: "atlas",
      definitionVersionId: "definition:built-in:atlas:v1",
    },
    principal: {
      principalId: "agent:atlas:test",
      principalVersionId: "agent:atlas:test:g1",
      contextGrantIds: ["context:atlas-read"],
      capabilityGrantIds: ["capability:atlas-read"],
    },
  });
  routeMocks.listConversationSummaries.mockReset().mockResolvedValue([]);
  routeMocks.listThreadTurns.mockReset().mockResolvedValue([]);
  routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment.mockReset()
    .mockResolvedValue(null);
  routeMocks.requestSharedMemoryAccessFromSecurityContext.mockReset()
    .mockResolvedValue({
      actorBinding: {
        version: 1,
        kind: "auth_user",
        authUserId: context.auth.userId,
        canonicalActorId: `actor:${context.auth.userId}`,
        legacyOwnerActorIds: [context.actorId],
        readableOwnerActorIds: [
          `actor:${context.auth.userId}`,
          context.actorId,
        ],
      },
      authority: {
        scope: "project",
        workspaceId: "workspace:team-a",
        projectId: "project:launch",
      },
      executionScope: {},
      databaseAccessScope: {},
    });
  routeMocks.requireActivePersonalContextConsent.mockReset().mockResolvedValue({
    authoritySha256: "a".repeat(64),
  });
  routeMocks.personalContextMemoryAccessFromSecurityContext.mockReset()
    .mockReturnValue({ schemaVersion: 1, authority: "personal" });
  routeMocks.resolveLoopV2ModelTextEnrollment.mockReset()
    .mockResolvedValue(null);
  routeMocks.resolveLoopV2ContextTextEnrollment.mockReset()
    .mockResolvedValue(null);
  routeMocks.resolveSemanticIntent.mockReset()
    .mockImplementation(async ({ baseline }) => ({
      decision: baseline,
      capabilitySearchQuery: "",
      receipt: {
        schemaVersion: 1,
        policyVersion: "semantic-intent-policy-v2",
        source: "deterministic_fallback",
        intent: "not_evaluated",
        executionShape: "not_evaluated",
        confidence: null,
        entityCount: 0,
        unresolvedEntityCount: 0,
        capabilityQuery: "",
        matchedCapabilityIds: [],
        route: baseline.route,
        requiresApproval: baseline.requiresApproval,
        clarificationAdvisory: false,
        fallbackReasonCode: "model_unavailable",
      },
    }));
  routeMocks.syncMissionExecutor.mockReset().mockResolvedValue(undefined);
  routeMocks.transitionMission.mockReset();
  routeMocks.runAgent.mockReset();
  routeMocks.runLoopV2ModelText.mockReset();
  routeMocks.runLoopV2ReadOnlyCanary.mockReset();
});

describe("agent intent clarification", () => {
  it("cannot be bypassed by an explicit strategy and performs no agent execution", async () => {
    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Delete the old project",
        requestId: "clarify-delete-a",
        strategy: "direct",
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('event: clarification');
    expect(body).toContain('"reasonCode":"ambiguous_destructive_target"');
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
    expect(routeMocks.listThreadTurns).not.toHaveBeenCalled();
    expect(routeMocks.appendThreadTurn).toHaveBeenNthCalledWith(1, {
      tenantId: context.tenantId,
      threadId: "thread-a",
      role: "user",
      content: "Delete the old project",
    });
    expect(routeMocks.appendThreadTurn).toHaveBeenNthCalledWith(2, {
      tenantId: context.tenantId,
      threadId: "thread-a",
      role: "assistant",
      content: "Name or identify the exact item you want changed before I continue.",
    });
    expect(routeMocks.appendScopedDomainEvent).toHaveBeenCalledWith({
      streamId: "thread:thread-a",
      type: "intent.clarification_requested",
      executionScope: expect.objectContaining({
        tenantId: context.tenantId,
        initiatingActorId: context.actorId,
        executingPrincipalType: "agent",
        executingPrincipalId: "agent:atlas:test",
        contextGrantIds: ["context:atlas-read"],
        capabilityGrantIds: ["capability:atlas-read"],
        correlationId: "clarify-delete-a",
        causationId: "turn-user",
        purpose: "agent.intent.clarification",
      }),
      payload: {
        schemaVersion: 1,
        threadId: "thread-a",
        route: "clarify",
        reasonCode: "ambiguous_destructive_target",
        selectedTargetIds: [],
        selectedToolIds: [],
        effectCount: 0,
      },
    });
    expect(routeMocks.authorizeRequest).toHaveBeenCalledTimes(1);
  });
});

describe("agent semantic intent routing", () => {
  it("binds a reviewed voice command to its owned conversation and governed runner", async () => {
    const voiceThreadId = "22222222-2222-4222-8222-222222222222";
    const voiceSessionId = "33333333-3333-4333-8333-333333333333";
    routeMocks.getThread.mockResolvedValue({
      id: voiceThreadId,
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-voice", threadId: voiceThreadId };
      yield { type: "done", response: "Calendar loaded." };
    });
    const voiceInput = {
      schemaVersion: 1,
      source: "realtime_voice",
      sessionId: voiceSessionId,
      conversationId: voiceThreadId,
      provider: "openai",
      confidenceBand: "low",
      confidenceMean: 0.48,
      confidenceMinimum: 0.09,
      confidenceSampleCount: 4,
      reviewMethod: "explicit_checkbox",
      reviewAttested: true,
    } as const;

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Show tomorrow's calendar.",
        threadId: voiceThreadId,
        requestId: "voice-command-a",
        strategy: "direct",
        voiceInput,
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment).not.toHaveBeenCalled();
    expect(routeMocks.resolveLoopV2ModelTextEnrollment).not.toHaveBeenCalled();
    expect(routeMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `thread:${voiceThreadId}`,
        type: "voice.command_reviewed",
        payload: expect.objectContaining({
          voiceSessionId,
          confidenceBand: "low",
          reviewMethod: "explicit_checkbox",
          reviewAttested: true,
          forceApprovalAboveRisk: 0,
          transcriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ voiceInput }),
      expect.any(AbortSignal),
    );
  });

  it("rejects voice metadata bound to another conversation", async () => {
    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Run this.",
        threadId: "22222222-2222-4222-8222-222222222222",
        voiceInput: {
          schemaVersion: 1,
          source: "realtime_voice",
          sessionId: "33333333-3333-4333-8333-333333333333",
          conversationId: "44444444-4444-4444-8444-444444444444",
          provider: "openai",
          confidenceBand: "unavailable",
          confidenceSampleCount: 0,
          reviewMethod: "explicit_checkbox",
          reviewAttested: true,
        },
      }),
    }));

    expect(response.status).toBe(400);
    expect(routeMocks.authorizeRequest).not.toHaveBeenCalled();
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });

  it("rejects an unsigned explicit context selection after authentication", async () => {
    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Summarize the selected context.",
        contextScope: "explicit_selection",
        contextSelection: {
          query: "Summarize the selected context.",
          evidenceIds: [],
          lockToken: `${"a".repeat(80)}.bbbb`,
        },
      }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Context selection lock is invalid.",
    });
    expect(routeMocks.authorizeRequest).toHaveBeenCalledTimes(1);
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });

  it("rejects personal context when standing consent is inactive", async () => {
    routeMocks.authorizeRequest.mockResolvedValue({
      ...context,
      actorId: context.auth.email,
    });
    const { PersonalContextConsentError } = await import(
      "@/lib/memory/personal-context-consent-store"
    );
    routeMocks.requireActivePersonalContextConsent.mockRejectedValue(
      new PersonalContextConsentError(
        "inactive",
        "Personal automatic context is not currently authorized.",
      ),
    );
    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Use all personal context.",
        contextScope: "personal",
      }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Personal context not authorized",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.authorizeRequest).toHaveBeenCalledOnce();
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });

  it("binds active personal consent to a direct agent run", async () => {
    const personalContext = { ...context, actorId: context.auth.email };
    routeMocks.authorizeRequest.mockResolvedValue(personalContext);
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-personal-context" };
      yield { type: "done", response: "Personal context used." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Use relevant saved personal preferences.",
        requestId: "personal-context-a",
        strategy: "direct",
        contextScope: "personal",
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.requireActivePersonalContextConsent).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorBinding: expect.objectContaining({
        canonicalActorId: `actor:${context.auth.userId}`,
      }),
    });
    expect(routeMocks.personalContextMemoryAccessFromSecurityContext)
      .toHaveBeenCalledWith(personalContext, {
        correlationId: "personal-context-a",
        consentAuthority: { authoritySha256: "a".repeat(64) },
      });
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        contextScope: "personal",
        promptPersonalMemoryAccess: {
          schemaVersion: 1,
          authority: "personal",
        },
        executionScope: expect.objectContaining({
          correlationId: "personal-context-a",
          workspaceId: null,
          projectId: null,
          missionId: null,
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("binds project context authority to the direct agent execution scope", async () => {
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-project-context" };
      yield { type: "done", response: "Project context used." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Use the selected project's launch knowledge.",
        requestId: "project-context-a",
        projectId: "project-a",
        strategy: "direct",
        contextScope: "project",
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.requestSharedMemoryAccessFromSecurityContext)
      .toHaveBeenCalledWith(context, {
        scope: "project",
        projectId: "project-a",
        correlationId: "project-context-a",
      });
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        contextScope: "project",
        promptSharedMemoryAccess: expect.objectContaining({
          authority: expect.objectContaining({
            workspaceId: "workspace:team-a",
            projectId: "project:launch",
          }),
        }),
        executionScope: expect.objectContaining({
          workspaceId: "workspace:team-a",
          projectId: "project:launch",
          correlationId: "project-context-a",
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("binds Mission context through its canonical Project membership", async () => {
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-mission-context" };
      yield { type: "done", response: "Mission context used." };
    });
    const missionId = "11111111-1111-4111-8111-111111111111";

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Continue the attached Mission.",
        requestId: "mission-context-a",
        missionId,
        strategy: "direct",
        contextScope: "mission",
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.requestSharedMemoryAccessFromSecurityContext)
      .toHaveBeenCalledWith(context, {
        scope: "project",
        projectId: missionId,
        correlationId: "mission-context-a",
      });
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        contextScope: "mission",
        promptSharedMemoryAccess: expect.any(Object),
        executionScope: expect.objectContaining({
          workspaceId: "workspace:team-a",
          projectId: "project:launch",
          missionId,
          correlationId: "mission-context-a",
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("admits exact agent-private context without an explicit selection", async () => {
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-agent-private" };
      yield { type: "done", response: "Agent memory used." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Use only this agent's retained procedure.",
        requestId: "agent-private-scope-a",
        strategy: "direct",
        contextScope: "agent_private",
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        contextScope: "agent_private",
        contextSelection: undefined,
      }),
      expect.any(AbortSignal),
    );
  });

  it("requires reviewed evidence only for explicit-selection scope", async () => {
    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Use this conversation.",
        contextScope: "session",
        contextSelection: {
          query: "Use this conversation.",
          evidenceIds: [],
          lockToken: `${"a".repeat(80)}.bbbb`,
        },
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid context scope",
      message: expect.stringMatching(/explicit-selection scope/i),
    });
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });

  it("keeps current-turn scope out of thread history and Loop canaries", async () => {
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-current-turn", threadId: "thread-a" };
      yield { type: "done", response: "Current turn only." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Answer only from this message.",
        requestId: "current-turn-scope-a",
        strategy: "direct",
        contextScope: "current_turn",
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.listThreadTurns).not.toHaveBeenCalled();
    expect(routeMocks.listConversationSummaries).not.toHaveBeenCalled();
    expect(routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment).not.toHaveBeenCalled();
    expect(routeMocks.resolveLoopV2ModelTextEnrollment).not.toHaveBeenCalled();
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        contextScope: "current_turn",
        messages: [{ role: "user", content: "Answer only from this message." }],
      }),
      expect.any(AbortSignal),
    );
  });

  it("drops caller-supplied history from current-turn scope", async () => {
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-current-turn-array" };
      yield { type: "done", response: "Latest message only." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "Private prior message." },
          { role: "assistant", content: "Private prior response." },
          { role: "user", content: "Use only this latest message." },
        ],
        requestId: "current-turn-array-a",
        strategy: "direct",
        contextScope: "current_turn",
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "user", content: "Use only this latest message." },
        ],
      }),
      expect.any(AbortSignal),
    );
  });

  it("records the validated decision and passes only discovery hints to the runner", async () => {
    routeMocks.resolveSemanticIntent.mockResolvedValue({
      decision: {
        route: "direct",
        score: 1,
        reasons: ["Semantic single action."],
        requiresApproval: false,
        primaryAgentId: "scout",
        specialistIds: ["scout"],
        ambiguity: { state: "none" },
      },
      capabilitySearchQuery: "list github issues",
      receipt: {
        schemaVersion: 1,
        policyVersion: "semantic-intent-policy-v2",
        source: "model",
        intent: "retrieve",
        executionShape: "single_action",
        confidence: 0.98,
        entityCount: 1,
        unresolvedEntityCount: 0,
        capabilityQuery: "list github issues",
        matchedCapabilityIds: ["github.issues.list"],
        route: "direct",
        requiresApproval: false,
        clarificationAdvisory: false,
        model: {
          provider: "openai",
          model: "router-model",
          usageReceiptRecorded: true,
          usageReceiptId: "usage-route-a",
        },
      },
    });
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-legacy", threadId: "thread-a" };
      yield { type: "done", response: "Issue list." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Show repository issues.",
        requestId: "semantic-route-a",
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "intent.semantic_resolved",
        streamId: "intent:semantic-route-a",
        executionScope: expect.objectContaining({
          tenantId: "tenant-a",
          initiatingActorId: "actor-a",
          purpose: "agent.intent.semantic_resolution",
        }),
        payload: expect.objectContaining({
          source: "model",
          intent: "retrieve",
          matchedCapabilityIds: ["github.issues.list"],
          selectedToolIds: [],
          effectCount: 0,
        }),
      }),
    );
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "scout",
        securityContext: context,
        semanticRouting: {
          capabilitySearchQuery: "list github issues",
          matchedCapabilityIds: ["github.issues.list"],
          policyVersion: "semantic-intent-policy-v2",
        },
      }),
      expect.any(AbortSignal),
    );
  });

  it("narrows an explicit budget and keeps that run on the governed agent loop", async () => {
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-budgeted", threadId: "thread-a" };
      yield { type: "done", response: "Bounded result." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Summarize this safely.",
        requestId: "budgeted-agent-a",
        budgets: { toolCalls: 2, browserActions: 0, fanOut: 0 },
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment)
      .not.toHaveBeenCalled();
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetLimits: expect.objectContaining({
          toolCalls: 2,
          browserActions: 0,
          fanOut: 0,
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("rejects a requested budget above server authority before execution", async () => {
    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Use an unlimited run.",
        requestId: "budget-broadening-a",
        budgets: { agents: 6 },
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid run budget",
      message: expect.stringMatching(/cannot exceed its parent limit/i),
    });
    expect(routeMocks.authorizeRequest).toHaveBeenCalledTimes(1);
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });
});

describe("agent Loop v2 canary routing", () => {
  it("rejects a resume identifier without its actor-owned thread binding", async () => {
    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "yes",
        resumeRunId: "00000000-0000-4000-8000-000000000001",
      }),
    }));

    expect(response.status).toBe(400);
    expect(routeMocks.authorizeRequest).not.toHaveBeenCalled();
    expect(routeMocks.runLoopV2ReadOnlyCanary).not.toHaveBeenCalled();
  });

  it("uses the pinned canary runner without invoking the legacy loop", async () => {
    const enrollment = { enginePin: { engineVersionId: "loop-v2-test" } };
    routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment.mockResolvedValue(
      enrollment,
    );
    routeMocks.runLoopV2ReadOnlyCanary.mockImplementation(async function* () {
      yield { type: "run", runId: "run-v2", threadId: "thread-a" };
      yield { type: "done", response: "Here are your recent runs." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Show my recent runs",
        requestId: "loop-v2-list-runs-a",
        strategy: "auto",
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('event: run');
    expect(body).toContain('event: done');
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
    expect(
      routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment,
    ).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      message: "Show my recent runs",
      mode: "orchestrate",
      route: "direct",
      requiresApproval: false,
      requestUsesMessageField: true,
    }));
    expect(routeMocks.runLoopV2ReadOnlyCanary).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Show my recent runs",
        agentId: "atlas",
        enrollment,
        executionScope: expect.objectContaining({
          purpose: "agent.loop.v2.read_only_canary",
          initiatingActorId: "actor-a",
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("uses the model-text canary only after the read canary declines", async () => {
    const enrollment = { enginePin: { engineVersionId: "model-v2-test" } };
    routeMocks.resolveLoopV2ModelTextEnrollment.mockResolvedValue(enrollment);
    routeMocks.runLoopV2ModelText.mockImplementation(async function* () {
      yield { type: "run", runId: "run-model-v2", threadId: "thread-a" };
      yield { type: "done", response: "A bounded summary." };
    });
    const message = `Summarize: ${"A governed agent action preserves explicit tenant and actor attribution. ".repeat(2)}`;

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        requestId: "loop-v2-model-text-a",
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('event: run');
    expect(body).toContain('event: done');
    expect(routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment)
      .toHaveBeenCalledTimes(1);
    expect(routeMocks.resolveLoopV2ModelTextEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        message,
        mode: "orchestrate",
        route: "direct",
        requestUsesMessageField: true,
      }),
    );
    expect(routeMocks.runLoopV2ModelText).toHaveBeenCalledWith(
      expect.objectContaining({
        message,
        agentId: "atlas",
        enrollment,
        executionScope: expect.objectContaining({
          purpose: "agent.loop.v2.model_text_canary",
          initiatingActorId: "actor-a",
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(routeMocks.runLoopV2ReadOnlyCanary).not.toHaveBeenCalled();
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });

  it("routes an explicit context scope through the separately pinned context canary", async () => {
    const enrollment = { enginePin: { engineVersionId: "context-v2-test" } };
    routeMocks.resolveLoopV2ContextTextEnrollment.mockResolvedValue(enrollment);
    routeMocks.createThread.mockResolvedValue({
      id: "thread-a",
      tenantId: context.tenantId,
      actorId: context.actorId,
      projectId: "ambient-thread-project",
    });
    routeMocks.runLoopV2ModelText.mockImplementation(async function* () {
      yield { type: "run", runId: "run-context-v2", threadId: "thread-a" };
      yield { type: "done", response: "A context-bound summary." };
    });
    const message = `Summarize: ${
      "A governed agent action preserves explicit tenant and actor attribution. ".repeat(2)
    }`;

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        requestId: "loop-v2-context-text-a",
        contextScope: "session",
      }),
    }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("A context-bound summary.");
    expect(routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment).not
      .toHaveBeenCalled();
    expect(routeMocks.resolveLoopV2ModelTextEnrollment).not.toHaveBeenCalled();
    expect(routeMocks.resolveLoopV2ContextTextEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        message,
        contextScope: "session",
        requestedAgentId: "atlas",
      }),
    );
    expect(routeMocks.runLoopV2ModelText).toHaveBeenCalledWith(
      expect.objectContaining({
        message,
        contextScope: "session",
        enrollment,
        executionScope: expect.objectContaining({
          purpose: "agent.loop.v2.context_text_canary",
          projectId: null,
          missionId: null,
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });

  it("routes an explicit confirmation back to the exact paused run", async () => {
    const enrollment = { enginePin: { engineVersionId: "loop-v2-test" } };
    routeMocks.getThread.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000002",
      tenantId: context.tenantId,
      actorId: context.actorId,
      mode: "orchestrate",
    });
    routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment.mockResolvedValue(
      enrollment,
    );
    routeMocks.runLoopV2ReadOnlyCanary.mockImplementation(async function* () {
      yield {
        type: "run",
        runId: "00000000-0000-4000-8000-000000000001",
        threadId: "00000000-0000-4000-8000-000000000002",
      };
      yield { type: "done", response: "Here are your recent runs." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "yes",
        threadId: "00000000-0000-4000-8000-000000000002",
        resumeRunId: "00000000-0000-4000-8000-000000000001",
        requestId: "loop-v2-clarification-a",
        strategy: "auto",
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("event: done");
    expect(routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "yes",
        resumeRunId: "00000000-0000-4000-8000-000000000001",
      }),
    );
    expect(routeMocks.runLoopV2ReadOnlyCanary).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "yes",
        threadId: "00000000-0000-4000-8000-000000000002",
        resumeRunId: "00000000-0000-4000-8000-000000000001",
        enrollment,
      }),
      expect.any(AbortSignal),
    );
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });
});
