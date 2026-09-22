import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  after: vi.fn(),
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
  inspectPromptQueueDispatchReceipt: vi.fn(),
  resolveAgentIdentityForExecution: vi.fn(),
  listConversationSummaries: vi.fn(),
  listThreadTurns: vi.fn(),
  resolveLoopV2ContextTextEnrollment: vi.fn(),
  resolveLoopV2ModelTextEnrollment: vi.fn(),
  resolveLoopV2ReadOnlyCanaryEnrollment: vi.fn(),
  requestSharedMemoryAccessFromSecurityContext: vi.fn(),
  personalContextMemoryAccessFromSecurityContext: vi.fn(),
  requireActivePersonalContextConsent: vi.fn(),
  recordPromptQueueDispatchProgress: vi.fn(),
  resolveSemanticIntent: vi.fn(),
  runAgent: vi.fn(),
  runLoopV2ModelText: vi.fn(),
  runLoopV2ReadOnlyCanary: vi.fn(),
  startLocalComputerSession: vi.fn(),
  syncMissionExecutor: vi.fn(),
  transitionMission: vi.fn(),
  validatePromptQueueDispatch: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: routeMocks.after,
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

vi.mock("@/lib/command/prompt-queue-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/command/prompt-queue-store")>()),
  recordPromptQueueDispatchProgress:
    routeMocks.recordPromptQueueDispatchProgress,
  inspectPromptQueueDispatchReceipt:
    routeMocks.inspectPromptQueueDispatchReceipt,
  validatePromptQueueDispatch: routeMocks.validatePromptQueueDispatch,
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

vi.mock("@/lib/local-computer/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-computer/store")>()),
  startLocalComputerSession: routeMocks.startLocalComputerSession,
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
  routeMocks.after.mockReset();
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
  routeMocks.recordPromptQueueDispatchProgress.mockReset()
    .mockResolvedValue({ status: "applied" });
  routeMocks.inspectPromptQueueDispatchReceipt.mockReset()
    .mockResolvedValue({ status: "stale" });
  routeMocks.validatePromptQueueDispatch.mockReset().mockResolvedValue({
    agent: {
      logicalAgentId: "atlas",
      definitionVersionId: "definition:built-in:atlas:v1",
      principalVersionId: "agent:atlas:test:g1",
    },
    model: {
      providerId: "openai",
      modelId: "gpt-test",
      tier: "reasoning",
      routingPolicySha256: "a".repeat(64),
    },
  });
  routeMocks.runAgent.mockReset();
  routeMocks.runLoopV2ModelText.mockReset();
  routeMocks.runLoopV2ReadOnlyCanary.mockReset();
  routeMocks.startLocalComputerSession.mockReset().mockResolvedValue({
    id: `local_computer_session_${"a".repeat(48)}`,
    deviceId: "mac-device-local",
    expiresAt: "2026-09-17T12:00:00.000Z",
  });
});

function authorizeCanonicalQueueRequest() {
  const queueContext = {
    ...context,
    actorId: context.auth.email,
  };
  routeMocks.authorizeRequest.mockResolvedValue(queueContext);
  routeMocks.createThread.mockResolvedValue({
    id: "thread-a",
    tenantId: context.tenantId,
    actorId: queueContext.actorId,
  });
  return queueContext;
}

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

describe("agent prompt queue lifecycle", () => {
  it("persists run and terminal receipts in-band under the canonical queue owner", async () => {
    authorizeCanonicalQueueRequest();
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-queued", threadId: "thread-a" };
      yield { type: "done", response: "Queued result." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-asael-prompt-queue-item":
          "11111111-1111-4111-8111-111111111111",
        "x-asael-prompt-queue-token": "private-dispatch-token",
      },
      body: JSON.stringify({
        message: "Inspect the queued context.",
        requestId: "prompt-queue-request-a",
        strategy: "direct",
        agentId: "atlas",
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.indexOf('"type":"run"')).toBeLessThan(
      body.indexOf('"type":"done"'),
    );
    expect(routeMocks.validatePromptQueueDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "11111111-1111-4111-8111-111111111111",
        dispatchToken: "private-dispatch-token",
        tenantId: context.tenantId,
        ownerActorId: `actor:${context.auth.userId}`,
        sessionId: context.auth.sessionId,
      }),
    );
    expect(routeMocks.recordPromptQueueDispatchProgress).toHaveBeenCalledTimes(2);
    expect(routeMocks.recordPromptQueueDispatchProgress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ownerActorId: `actor:${context.auth.userId}`,
        runId: "run-queued",
        threadId: "thread-a",
        progressLabel: "Governed run accepted",
      }),
    );
    expect(routeMocks.recordPromptQueueDispatchProgress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ownerActorId: `actor:${context.auth.userId}`,
        runId: "run-queued",
        threadId: "thread-a",
        terminal: "completed",
      }),
    );
    expect(JSON.stringify(routeMocks.runAgent.mock.calls[0]?.[0])).not.toContain(
      "private-dispatch-token",
    );
  });

  it("withholds a terminal event and emits a generic error when its queue receipt fails", async () => {
    authorizeCanonicalQueueRequest();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    routeMocks.recordPromptQueueDispatchProgress
      .mockResolvedValueOnce({ status: "applied" })
      .mockRejectedValueOnce(new Error("sensitive database receipt detail"));
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-terminal-failure", threadId: "thread-a" };
      yield { type: "done", response: "Durable result that must be withheld." };
    });

    try {
      const response = await POST(new Request("http://asael.test/api/agent", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-asael-prompt-queue-item":
            "11111111-1111-4111-8111-111111111111",
          "x-asael-prompt-queue-token": "private-dispatch-token",
        },
        body: JSON.stringify({
          message: "Inspect the queued context.",
          requestId: "prompt-queue-terminal-failure-a",
          strategy: "direct",
          agentId: "atlas",
        }),
      }));

      const body = await response.text();
      expect(body).toContain('"type":"run"');
      expect(body).not.toContain('"type":"done"');
      expect(body).not.toContain("Durable result that must be withheld.");
      expect(body).not.toContain("sensitive database receipt detail");
      expect(body).toContain(
        "The queued result could not be linked to its queue item.",
      );
      expect(routeMocks.recordPromptQueueDispatchProgress).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
    }
  });

  it("aborts the Agent on stream cancellation and records run_canceled without writing to the closed transport", async () => {
    authorizeCanonicalQueueRequest();
    let agentSignal: AbortSignal | undefined;
    routeMocks.runAgent.mockImplementation(async function* (
      _input: unknown,
      signal: AbortSignal,
    ) {
      agentSignal = signal;
      yield { type: "run", runId: "run-canceled", threadId: "thread-a" };
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-asael-prompt-queue-item":
          "11111111-1111-4111-8111-111111111111",
        "x-asael-prompt-queue-token": "private-dispatch-token",
      },
      body: JSON.stringify({
        message: "Inspect the queued context.",
        requestId: "prompt-queue-cancel-a",
        strategy: "direct",
        agentId: "atlas",
      }),
    }));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let body = "";
    while (!body.includes('"type":"run"')) {
      const chunk = await reader!.read();
      expect(chunk.done).toBe(false);
      body += decoder.decode(chunk.value, { stream: true });
    }

    await reader!.cancel("test transport disconnected");
    await vi.waitFor(() => {
      expect(routeMocks.recordPromptQueueDispatchProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-canceled",
          terminal: "failed",
          failureCode: "run_canceled",
        }),
      );
    });
    expect(agentSignal?.aborted).toBe(true);
    expect(routeMocks.recordPromptQueueDispatchProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "run_failed" }),
    );
  });

  it("stops before clarification or workflow mutations when the stream is canceled during planning", async () => {
    authorizeCanonicalQueueRequest();
    let releasePerformance!: (value: []) => void;
    const performanceGate = new Promise<[]>((resolve) => {
      releasePerformance = resolve;
    });
    routeMocks.getAgentPerformance.mockReturnValueOnce(performanceGate);
    const requestAbort = new AbortController();

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-asael-prompt-queue-item":
          "11111111-1111-4111-8111-111111111111",
        "x-asael-prompt-queue-token": "private-dispatch-token",
      },
      body: JSON.stringify({
        message: "Create a durable workflow after planning.",
        requestId: "prompt-queue-cancel-before-mutation-a",
        strategy: "direct",
        agentId: "atlas",
      }),
      signal: requestAbort.signal,
    }));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader!.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain(
      '\"label\":\"supervisor routing\"',
    );

    requestAbort.abort("test canceled during planning");
    await reader!.cancel("test transport disconnected during planning");
    releasePerformance([]);

    await vi.waitFor(() => {
      expect(routeMocks.recordPromptQueueDispatchProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          terminal: "failed",
          failureCode: "run_canceled",
        }),
      );
    });
    expect(routeMocks.createThread).not.toHaveBeenCalled();
    expect(routeMocks.appendThreadTurn).not.toHaveBeenCalled();
    expect(routeMocks.createMission).not.toHaveBeenCalled();
    expect(routeMocks.ensureMissionTask).not.toHaveBeenCalled();
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });

  it("does not replace a durable queue success when mission synchronization fails", async () => {
    authorizeCanonicalQueueRequest();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    routeMocks.syncMissionExecutor.mockRejectedValueOnce(
      new Error("mission projection unavailable"),
    );
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-mission-done", threadId: "thread-a" };
      yield { type: "done", response: "Durable Agent success." };
    });

    try {
      const response = await POST(new Request("http://asael.test/api/agent", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-asael-prompt-queue-item":
            "11111111-1111-4111-8111-111111111111",
          "x-asael-prompt-queue-token": "private-dispatch-token",
        },
        body: JSON.stringify({
          message: "Complete the selected mission task.",
          requestId: "prompt-queue-mission-sync-a",
          strategy: "direct",
          agentId: "atlas",
          missionId: "11111111-1111-4111-8111-111111111111",
        }),
      }));

      const body = await response.text();
      expect(body).toContain('"type":"done"');
      expect(body).toContain("Durable Agent success.");
      expect(routeMocks.recordPromptQueueDispatchProgress).toHaveBeenCalledTimes(2);
      expect(routeMocks.recordPromptQueueDispatchProgress).toHaveBeenLastCalledWith(
        expect.objectContaining({
          runId: "run-mission-done",
          terminal: "completed",
        }),
      );
      expect(routeMocks.recordPromptQueueDispatchProgress).not.toHaveBeenCalledWith(
        expect.objectContaining({ failureCode: "run_failed" }),
      );
      expect(logged).toHaveBeenCalledWith(
        "Mission executor synchronization failed after durable Agent outcome.",
        "mission projection unavailable",
      );
    } finally {
      logged.mockRestore();
    }
  });
});

describe("agent semantic intent routing", () => {
  it("binds This Mac explicitly, forces the direct runner, and skips rollout canaries", async () => {
    const macContext = {
      ...context,
      source: "mobile" as const,
      native: {
        deviceId: "mac-device-local",
        platform: "macos" as const,
        clientContractVersion: 12,
      },
    };
    routeMocks.authorizeRequest.mockResolvedValue(macContext);
    routeMocks.resolveSemanticIntent.mockResolvedValue({
      decision: {
        route: "durable_workflow",
        score: 1,
        reasons: ["A caller strategy cannot move local control away from its request."],
        requiresApproval: false,
        primaryAgentId: "atlas",
        specialistIds: [],
        ambiguity: { state: "none" },
      },
      capabilitySearchQuery: "control this installed mac",
      receipt: {
        schemaVersion: 1,
        policyVersion: "semantic-intent-policy-v2",
        source: "deterministic_fallback",
        intent: "execute",
        executionShape: "single_action",
        confidence: 1,
        entityCount: 1,
        unresolvedEntityCount: 0,
        capabilityQuery: "control this installed mac",
        matchedCapabilityIds: [],
        route: "durable_workflow",
        requiresApproval: false,
        clarificationAdvisory: false,
      },
    });
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-local-mac", threadId: "thread-a" };
      yield { type: "done", response: "The installed Mac was observed." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Observe Finder on this Mac.",
        requestId: "local-mac-request-a",
        strategy: "durable",
        computerUseTarget: "local_macos",
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.startLocalComputerSession).toHaveBeenCalledWith(
      macContext,
      "local-mac-request-a",
    );
    expect(routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment).not.toHaveBeenCalled();
    expect(routeMocks.resolveLoopV2ModelTextEnrollment).not.toHaveBeenCalled();
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        computerUseTarget: "local_macos",
        maxToolSteps: 12,
        budgetLimits: expect.objectContaining({
          modelTurns: 14,
          tokens: 64_000,
          costMicrousd: 2_500_000,
          wallTimeMs: 240_000,
          toolCalls: 30,
          browserActions: 12,
        }),
        securityContext: macContext,
        executionScope: expect.objectContaining({
          correlationId: "local-mac-request-a",
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(routeMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "intent.semantic_resolved",
        payload: expect.objectContaining({
          appliedRoute: "direct",
          selectedTargetIds: ["computer:local_macos"],
        }),
      }),
    );
  });

  it("keeps ordinary runs at six tool steps and seven model turns", async () => {
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-standard-cap", threadId: "thread-a" };
      yield { type: "done", response: "Bounded result." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Inspect the requested context.",
        requestId: "ordinary-budget-a",
        strategy: "direct",
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        computerUseTarget: undefined,
        maxToolSteps: 6,
        budgetLimits: expect.objectContaining({ modelTurns: 7 }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("retires legacy Isolated Browser requests without retargeting This Mac", async () => {
    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Open the existing browser session.",
        requestId: "legacy-isolated-browser-a",
        computerUseTarget: "isolated_browser",
      }),
    }));

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      code: "computer_use_target_retired",
      target: "isolated_browser",
    });
    expect(routeMocks.authorizeRequest).not.toHaveBeenCalled();
    expect(routeMocks.startLocalComputerSession).not.toHaveBeenCalled();
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });

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
