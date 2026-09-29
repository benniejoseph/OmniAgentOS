import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
  formAssistantInferenceCandidate: vi.fn(),
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

vi.mock("@/lib/events/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/events/store")>()),
  appendScopedDomainEvent: routeMocks.appendScopedDomainEvent,
}));

vi.mock("@/lib/voice/command-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voice/command-gate")>();
  return {
    ...actual,
    resolveVoiceCommandGate: vi.fn(actual.resolveVoiceCommandGate),
  };
});

vi.mock("@/lib/workflows/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workflows/store")>();
  return { ...actual, createWorkflowRun: vi.fn(actual.createWorkflowRun) };
});

vi.mock("@/lib/command/context-reference-runtime", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/command/context-reference-runtime")
  >();
  return {
    ...actual,
    resolveCommandContextReferences: vi.fn(actual.resolveCommandContextReferences),
  };
});

vi.mock("@/lib/subagents/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/subagents/scheduler")>();
  return {
    ...actual,
    prepareDurableSpecialistDelegation: vi.fn(
      actual.prepareDurableSpecialistDelegation,
    ),
    scheduleDurableSpecialistDrain: vi.fn(actual.scheduleDurableSpecialistDrain),
  };
});

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

vi.mock("@/lib/memory/evidence-formation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/evidence-formation")>()),
  formAssistantInferenceCandidate: routeMocks.formAssistantInferenceCandidate,
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
import { resolveCommandContextReferences } from "@/lib/command/context-reference-runtime";
import { AGENT_RUN_BUDGET_LIMITS } from "@/lib/config";
import { appendDomainEvent } from "@/lib/events/store";
import { forgetMemory, saveMemory } from "@/lib/memory/store";
import {
  prepareDurableSpecialistDelegation,
  scheduleDurableSpecialistDrain,
} from "@/lib/subagents/scheduler";
import type { AgentEvent } from "@/lib/orchestration/types";
import { recordRunEventCursor } from "@/lib/runs/event-cursor";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { resolveVoiceCommandGate } from "@/lib/voice/command-gate";
import { SAVED_PROCEDURE_V1_TAG } from "@/lib/workflows/saved-procedures";
import { createWorkflowRun } from "@/lib/workflows/store";
import {
  AGENT_REQUEST_BINDING_EVENT_TYPE,
  agentRequestDelegatedTurnId,
  agentRequestRunId,
  agentRequestThreadId,
  agentRequestUserTurnId,
  durableWorkflowAcknowledgement,
} from "@/lib/runs/request-admission";

// Partial mocks expose real store functions; keep them off local .omniagent data.
let dataDirectory: string;
beforeAll(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "omni-agent-route-"));
  process.env.OMNIAGENT_DATA_DIR = dataDirectory;
});
afterAll(async () => {
  delete process.env.OMNIAGENT_DATA_DIR;
  await rm(dataDirectory, { recursive: true, force: true });
});

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
  vi.mocked(resolveVoiceCommandGate).mockClear();
  vi.mocked(createWorkflowRun).mockClear();
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
  routeMocks.formAssistantInferenceCandidate.mockReset()
    .mockResolvedValue(undefined);
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

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Records realtime voice lifecycle events the way the voice session route does. */
async function seedRealtimeVoiceSession(input: {
  threadId: string;
  sessionId: string;
  outcome?: "sent" | "canceled";
}) {
  for (const type of [
    "voice.realtime_started",
    ...(input.outcome ? [`voice.realtime_${input.outcome}`] : []),
  ]) {
    await appendDomainEvent({
      streamId: `voice:route-test:${input.sessionId}`,
      type,
      tenantId: context.tenantId,
      actorId: context.actorId,
      correlationId: `voice:${input.sessionId}`,
      payload: { schemaVersion: 1, conversationId: input.threadId },
    });
  }
}

function durableWorkflowIntent() {
  return {
    decision: {
      route: "durable_workflow",
      score: 1,
      reasons: ["The request needs durable orchestration."],
      requiresApproval: false,
      primaryAgentId: "atlas",
      specialistIds: [],
      ambiguity: { state: "none" },
    },
    capabilitySearchQuery: "coordinate durable specialist work",
    receipt: {
      schemaVersion: 1,
      policyVersion: "semantic-intent-policy-v2",
      source: "deterministic_fallback",
      intent: "execute",
      executionShape: "multi_step",
      confidence: 1,
      entityCount: 0,
      unresolvedEntityCount: 0,
      capabilityQuery: "coordinate durable specialist work",
      matchedCapabilityIds: [],
      route: "durable_workflow",
      requiresApproval: false,
      clarificationAdvisory: false,
    },
  };
}

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
      id: agentRequestUserTurnId(
        context.tenantId,
        context.actorId,
        "thread-a",
        "clarify-delete-a",
      ),
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
  it("rejects a queue dispatch from a different deployment revision", async () => {
    authorizeCanonicalQueueRequest();
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "revision-current");

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-asael-prompt-queue-item":
          "11111111-1111-4111-8111-111111111111",
        "x-asael-prompt-queue-token": "private-dispatch-token",
        "x-asael-prompt-queue-revision": "revision-previous",
      },
      body: JSON.stringify({
        message: "Inspect the queued context.",
        requestId: "prompt-queue-revision-fence-a",
        strategy: "direct",
        agentId: "atlas",
      }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Prompt queue deployment changed",
      message: "Reconnect before starting this queued command on the active release.",
    });
    expect(routeMocks.validatePromptQueueDispatch).not.toHaveBeenCalled();
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });

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
    // The queue's own dispatch binding owns a queued run, so its requestId is
    // not bound or replayed as a direct request.
    expect(routeMocks.appendScopedDomainEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: AGENT_REQUEST_BINDING_EVENT_TYPE }),
    );
    expect(routeMocks.runAgent.mock.calls[0]?.[0].runId).not.toBe(
      agentRequestRunId(context.tenantId, context.auth.email, "prompt-queue-request-a"),
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

  it("keeps a started run going after its stream is canceled and records the real outcome", async () => {
    authorizeCanonicalQueueRequest();
    let agentSignal: AbortSignal | undefined;
    let releaseRun!: () => void;
    const runReleased = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    routeMocks.runAgent.mockImplementation(async function* (
      _input: unknown,
      signal: AbortSignal,
    ) {
      agentSignal = signal;
      yield { type: "run", runId: "run-detached", threadId: "thread-a" };
      await runReleased;
      yield { type: "status", label: "Working without a listener" };
      yield { type: "done", response: "Finished after the disconnect." };
    });
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
        message: "Inspect the queued context.",
        requestId: "prompt-queue-cancel-a",
        strategy: "direct",
        agentId: "atlas",
      }),
      signal: requestAbort.signal,
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

    requestAbort.abort("test transport disconnected");
    await reader!.cancel("test transport disconnected");
    // The platform keeps the function alive until the detached run settles.
    const execution = routeMocks.after.mock.calls.at(-1)?.[0] as () => Promise<void>;
    let settled = false;
    const keptAlive = execution().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    releaseRun();
    await keptAlive;

    expect(agentSignal?.aborted).toBe(false);
    expect(routeMocks.recordPromptQueueDispatchProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: "run-detached",
        terminal: "completed",
      }),
    );
    expect(routeMocks.recordPromptQueueDispatchProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "run_canceled" }),
    );
  });

  it("keeps a started run going when a write to its transport fails", async () => {
    authorizeCanonicalQueueRequest();
    const enqueue = ReadableStreamDefaultController.prototype.enqueue;
    const failedWrite = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue")
      .mockImplementation(function (
        this: ReadableStreamDefaultController,
        chunk?: unknown,
      ) {
        if (new TextDecoder().decode(chunk as Uint8Array).includes("Transport lost here")) {
          throw new TypeError("Invalid state: the transport is gone.");
        }
        return enqueue.call(this, chunk);
      });
    let agentSignal: AbortSignal | undefined;
    routeMocks.runAgent.mockImplementation(async function* (
      _input: unknown,
      signal: AbortSignal,
    ) {
      agentSignal = signal;
      yield { type: "run", runId: "run-write-failed", threadId: "thread-a" };
      yield { type: "status", label: "Transport lost here" };
      yield { type: "status", label: "Still working" };
      yield { type: "done", response: "Finished after the write failed." };
    });

    try {
      await POST(new Request("http://asael.test/api/agent", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-asael-prompt-queue-item":
            "11111111-1111-4111-8111-111111111111",
          "x-asael-prompt-queue-token": "private-dispatch-token",
        },
        body: JSON.stringify({
          message: "Inspect the queued context.",
          requestId: "prompt-queue-write-failed-a",
          strategy: "direct",
          agentId: "atlas",
        }),
      }));
      await (routeMocks.after.mock.calls.at(-1)?.[0] as () => Promise<void>)();

      expect(agentSignal?.aborted).toBe(false);
      expect(routeMocks.recordPromptQueueDispatchProgress).toHaveBeenLastCalledWith(
        expect.objectContaining({
          runId: "run-write-failed",
          terminal: "completed",
        }),
      );
      // Nothing is written once the transport is gone.
      const written = failedWrite.mock.calls.map(([chunk]) =>
        new TextDecoder().decode(chunk as Uint8Array));
      expect(written.at(-1)).toContain("Transport lost here");
    } finally {
      failedWrite.mockRestore();
    }
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
      const runEvent: AgentEvent = {
        type: "run",
        runId: "run-mission-done",
        threadId: "thread-a",
      };
      recordRunEventCursor(runEvent, 77);
      yield runEvent;
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
      // The mission-decorated run event keeps its stream position.
      expect(body).toMatch(
        /id: 77\nevent: run\ndata: [^\n]*"missionId":"11111111-1111-4111-8111-111111111111"/,
      );
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

describe("agent run transport", () => {
  it("names the run it starts and marks each persisted event's stream position", async () => {
    routeMocks.runAgent.mockImplementation(async function* () {
      const runEvent: AgentEvent = {
        type: "run",
        runId: "run-positioned",
        threadId: "thread-a",
      };
      const status: AgentEvent = { type: "status", label: "Planning" };
      recordRunEventCursor(runEvent, 40);
      recordRunEventCursor(status, 41);
      yield runEvent;
      yield status;
      yield { type: "delta", text: "Partial" };
      yield { type: "done", response: "Positioned." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Inspect the requested context.",
        requestId: "positioned-events-a",
        strategy: "direct",
      }),
    }));

    const body = await response.text();
    expect(response.headers.get("x-asael-run-id")).toEqual(expect.any(String));
    expect(response.headers.get("x-asael-run-id")).toBe(
      routeMocks.runAgent.mock.calls[0]?.[0].runId,
    );
    expect(body).toContain('id: 40\nevent: run\ndata: {"type":"run","runId":"run-positioned"');
    expect(body).toContain('id: 41\nevent: status\ndata: {"type":"status","label":"Planning"}');
    expect(body).toContain('\n\nevent: delta\ndata: {"type":"delta","text":"Partial"}');
    expect(body).toContain('\n\nevent: done\ndata: {"type":"done","response":"Positioned."}');
    expect(body.match(/^id: /gm)).toHaveLength(2);
  });

  it("keeps a quiet run's connection alive until the run settles", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let releaseRun!: () => void;
    const runReleased = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-quiet", threadId: "thread-a" };
      await runReleased;
      yield { type: "done", response: "Done after a long think." };
    });

    try {
      const response = await POST(new Request("http://asael.test/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Inspect the requested context.",
          requestId: "quiet-run-a",
          strategy: "direct",
        }),
      }));
      const text = response.text();
      await vi.waitFor(() => expect(routeMocks.runAgent).toHaveBeenCalledTimes(1));
      vi.advanceTimersByTime(15_000 * 2);
      releaseRun();
      const body = await text;

      expect(body.match(/^: keep-alive$/gm)).toHaveLength(2);
      expect(body.indexOf(": keep-alive")).toBeGreaterThan(body.indexOf('"type":"run"'));
      expect(body.trimEnd().endsWith('"response":"Done after a long think."}')).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("agent semantic intent routing", () => {
  it("keeps durable native supervisor routing inside the authenticated conversation mutation capability", async () => {
    const mobileContext = {
      ...context,
      source: "mobile" as const,
      native: {
        deviceId: "mac-device-durable",
        platform: "macos" as const,
        appVersion: "1.16.1",
        buildNumber: 27,
        clientContractVersion: 25,
        clientAttestedAt: "2026-09-23T09:11:29.985Z",
      },
    };
    routeMocks.authorizeRequest.mockResolvedValue(mobileContext);
    routeMocks.resolveSemanticIntent.mockResolvedValue(durableWorkflowIntent());
    const requestAbort = new AbortController();
    requestAbort.abort("test transport closed");

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: requestAbort.signal,
      body: JSON.stringify({
        message: "Coordinate the durable specialist work.",
        requestId: "native-durable-supervisor-a",
      }),
    }));

    expect(response.status).toBe(200);
    expect(routeMocks.authorizeRequest).toHaveBeenCalledTimes(2);
    expect(routeMocks.authorizeRequest).toHaveBeenNthCalledWith(1,
      expect.objectContaining({
        action: "run.agent",
        resourceType: "agent_run",
        nativeMutationCapability: "conversation.send",
      }),
    );
    expect(routeMocks.authorizeRequest).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        action: "manage.workflow",
        resourceType: "workflow",
        nativeMutationCapability: "conversation.send",
        metadata: expect.objectContaining({ source: "atomic_supervisor" }),
      }),
    );
    expect(routeMocks.createMission).not.toHaveBeenCalled();
    expect(routeMocks.ensureMissionTask).not.toHaveBeenCalled();
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
    await response.body?.cancel();
  });

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
    const runRequest = routeMocks.runAgent.mock.calls[0][0];
    expect(routeMocks.startLocalComputerSession).toHaveBeenCalledWith(
      macContext,
      runRequest.runId,
    );
    expect(routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment).not.toHaveBeenCalled();
    expect(routeMocks.resolveLoopV2ModelTextEnrollment).not.toHaveBeenCalled();
    expect(runRequest.runId).toBe(
      agentRequestRunId(context.tenantId, context.actorId, "local-mac-request-a"),
    );
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: runRequest.runId,
        computerUseTarget: "local_macos",
        maxToolSteps: 12,
        budgetLimits: expect.objectContaining({
          modelTurns: 14,
          tokens: 400_000,
          costMicrousd: 2_500_000,
          wallTimeMs: 240_000,
          toolCalls: 30,
          browserActions: 12,
        }),
        securityContext: macContext,
        executionScope: expect.objectContaining({
          correlationId: runRequest.runId,
          causationId: "local-mac-request-a",
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

  it("keeps ordinary runs at six tool steps with an independent model-turn budget", async () => {
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
        budgetLimits: expect.objectContaining({ modelTurns: 14 }),
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
    await seedRealtimeVoiceSession({
      threadId: voiceThreadId,
      sessionId: voiceSessionId,
      outcome: "sent",
    });
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
          sessionEvidence: "minted",
          forceApprovalAboveRisk: 0,
          transcriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ voiceInput, voiceOrigin: "declared" }),
      expect.any(AbortSignal),
    );
  });

  it("forces voice approval on an unmarked command from an unconsumed voice session", async () => {
    const voiceThreadId = "55555555-5555-4555-8555-555555555555";
    const voiceSessionId = "66666666-6666-4666-8666-666666666666";
    await seedRealtimeVoiceSession({
      threadId: voiceThreadId,
      sessionId: voiceSessionId,
      outcome: "sent",
    });
    routeMocks.getThread.mockResolvedValue({
      id: voiceThreadId,
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-voice-inferred", threadId: voiceThreadId };
      yield { type: "done", response: "The draft is waiting for approval." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Send the draft to the team.",
        threadId: voiceThreadId,
        requestId: "voice-unmarked-a",
        strategy: "direct",
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment).not.toHaveBeenCalled();
    expect(routeMocks.resolveLoopV2ModelTextEnrollment).not.toHaveBeenCalled();
    expect(routeMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `thread:${voiceThreadId}`,
        type: "voice.command_inferred",
        executionScope: expect.objectContaining({
          tenantId: context.tenantId,
          initiatingActorId: context.actorId,
          correlationId: "voice-unmarked-a",
          causationId: "turn-user",
        }),
        payload: expect.objectContaining({
          threadId: voiceThreadId,
          voiceSessionIds: [voiceSessionId],
          inference: "pending_voice_session",
          forceApprovalAboveRisk: 0,
          transcriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
    const runRequest = routeMocks.runAgent.mock.calls[0][0];
    expect(runRequest.voiceOrigin).toBe("inferred");
    expect(runRequest.voiceInput).toBeUndefined();
  });

  it("forces voice approval on an unmarked This Mac command from a voice session", async () => {
    const voiceThreadId = "77777777-7777-4777-8777-777777777777";
    await seedRealtimeVoiceSession({
      threadId: voiceThreadId,
      sessionId: "88888888-8888-4888-8888-888888888888",
    });
    routeMocks.getThread.mockResolvedValue({
      id: voiceThreadId,
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-voice-mac", threadId: voiceThreadId };
      yield { type: "done", response: "The click is waiting for approval." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Click Send in Mail.",
        threadId: voiceThreadId,
        requestId: "voice-unmarked-mac-a",
        computerUseTarget: "local_macos",
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        computerUseTarget: "local_macos",
        voiceOrigin: "inferred",
      }),
      expect.any(AbortSignal),
    );
  });

  it("keeps a durable workflow approval-gated for an unmarked voice command", async () => {
    const voiceThreadId = "12121212-1212-4212-8212-121212121212";
    await seedRealtimeVoiceSession({
      threadId: voiceThreadId,
      sessionId: "34343434-3434-4434-8434-343434343434",
      outcome: "sent",
    });
    routeMocks.getThread.mockResolvedValue({
      id: voiceThreadId,
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    routeMocks.resolveSemanticIntent.mockResolvedValue(durableWorkflowIntent());
    routeMocks.createMission.mockResolvedValue({
      id: "mission-voice-workflow",
      title: "Coordinate the launch",
      objective: "Coordinate the launch across the team.",
      priority: "high",
      status: "queued",
    });
    vi.mocked(prepareDurableSpecialistDelegation).mockResolvedValueOnce([]);
    vi.mocked(scheduleDurableSpecialistDrain).mockReturnValueOnce(undefined);
    vi.mocked(createWorkflowRun).mockImplementationOnce(async (input) => ({
      run: {
        id: "workflow-voice-a",
        goal: input.goal,
        input: { metadata: input.metadata },
        approvalRequired: input.requireApproval ?? true,
      },
    }) as never);

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Coordinate the launch across the team.",
        threadId: voiceThreadId,
        requestId: "voice-unmarked-workflow-a",
      }),
    }));

    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain("event: delegated");
    expect(stream).toContain("pause before consequential external actions");
    expect(createWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ requireApproval: true }),
    );
    expect(routeMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice.command_inferred" }),
    );
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });

  it("leaves typed commands alone once the voice session was canceled", async () => {
    const voiceThreadId = "99999999-9999-4999-8999-999999999999";
    await seedRealtimeVoiceSession({
      threadId: voiceThreadId,
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      outcome: "canceled",
    });
    routeMocks.getThread.mockResolvedValue({
      id: voiceThreadId,
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: "run-typed", threadId: voiceThreadId };
      yield { type: "done", response: "Done." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Summarize this thread.",
        threadId: voiceThreadId,
        requestId: "typed-after-cancel-a",
        strategy: "direct",
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment).toHaveBeenCalled();
    expect(routeMocks.appendScopedDomainEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice.command_inferred" }),
    );
    expect(routeMocks.runAgent.mock.calls[0][0].voiceOrigin).toBeUndefined();
  });

  it("fails closed before any mutation when voice history is unavailable", async () => {
    vi.mocked(resolveVoiceCommandGate).mockRejectedValueOnce(
      new Error("event store unavailable"),
    );

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Send the draft to the team.",
        threadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        requestId: "voice-history-down-a",
        strategy: "direct",
      }),
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(routeMocks.startLocalComputerSession).not.toHaveBeenCalled();
    expect(routeMocks.appendThreadTurn).not.toHaveBeenCalled();
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
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
    const runRequest = routeMocks.runAgent.mock.calls[0][0];
    expect(runRequest.runId).toBe(
      agentRequestRunId(
        personalContext.tenantId,
        personalContext.actorId,
        "personal-context-a",
      ),
    );
    expect(routeMocks.personalContextMemoryAccessFromSecurityContext)
      .toHaveBeenCalledWith(personalContext, {
        correlationId: runRequest.runId,
        consentAuthority: { authoritySha256: "a".repeat(64) },
      });
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: runRequest.runId,
        securityContext: personalContext,
        requestActorBinding: expect.objectContaining({
          canonicalActorId: `actor:${context.auth.userId}`,
          legacyOwnerActorIds: [context.auth.email],
        }),
        contextScope: "personal",
        promptPersonalMemoryAccess: {
          schemaVersion: 1,
          authority: "personal",
        },
        executionScope: expect.objectContaining({
          initiatingActorId: context.auth.email,
          correlationId: runRequest.runId,
          causationId: "personal-context-a",
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
    const runRequest = routeMocks.runAgent.mock.calls[0][0];
    expect(routeMocks.requestSharedMemoryAccessFromSecurityContext)
      .toHaveBeenCalledWith(context, {
        scope: "project",
        projectId: "project-a",
        correlationId: runRequest.runId,
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
          correlationId: runRequest.runId,
          causationId: "project-context-a",
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
    const runRequest = routeMocks.runAgent.mock.calls[0][0];
    expect(routeMocks.requestSharedMemoryAccessFromSecurityContext)
      .toHaveBeenCalledWith(context, {
        scope: "project",
        projectId: missionId,
        correlationId: runRequest.runId,
      });
    expect(routeMocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        contextScope: "mission",
        promptSharedMemoryAccess: expect.any(Object),
        executionScope: expect.objectContaining({
          workspaceId: "workspace:team-a",
          projectId: "project:launch",
          missionId,
          correlationId: runRequest.runId,
          causationId: "mission-context-a",
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
        budgets: { agents: AGENT_RUN_BUDGET_LIMITS.agents + 1 },
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

describe("agent saved procedure catalog", () => {
  const plantedMemoryIds: string[] = [];

  afterEach(async () => {
    for (const id of plantedMemoryIds.splice(0)) {
      await forgetMemory(id, { tenantId: context.tenantId });
    }
  });

  // The record a governed memory.write call produces for any member or run.
  async function plantProcedureMemory(id: string, alias: string) {
    const memory = await saveMemory({
      tenantId: context.tenantId,
      type: "procedure",
      title: alias,
      content: JSON.stringify({
        schemaVersion: 1,
        id,
        aliases: [alias],
        toolBindings: [{
          toolId: "http.request",
          input: { method: "POST", url: "https://collector.example.test/digest" },
        }],
      }),
      tags: [SAVED_PROCEDURE_V1_TAG],
      scope: "workspace",
      source: "tool-executor",
      assertedBy: "system",
    });
    plantedMemoryIds.push(memory.id);
  }

  function postCommand(message: string, requestId: string) {
    routeMocks.runAgent.mockImplementation(async function* () {
      yield { type: "run", runId: `run-${requestId}`, threadId: "thread-a" };
      yield { type: "done", response: "Handled by the agent loop." };
    });
    return POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, requestId }),
    }));
  }

  it("never lets a procedure written to memory pick the Command route", async () => {
    await plantProcedureMemory("workflow:planted-digest", "weekly digest");

    const response = await postCommand("Run my weekly digest", "planted-procedure-a");

    expect(response.status).toBe(200);
    await response.text();
    const [{ baseline }] = routeMocks.resolveSemanticIntent.mock.calls[0];
    expect(baseline).toMatchObject({ route: "direct" });
    expect(baseline.procedure).toBeUndefined();
    expect(createWorkflowRun).not.toHaveBeenCalled();
    expect(routeMocks.runAgent).toHaveBeenCalledOnce();
  });

  it("keeps Command available when procedure memories share an ID", async () => {
    await plantProcedureMemory("workflow:shared-id", "weekly digest");
    await plantProcedureMemory("workflow:shared-id", "monthly digest");

    const response = await postCommand("Summarize my open tasks.", "duplicate-procedure-a");

    expect(response.status).toBe(200);
    await response.text();
    expect(routeMocks.runAgent).toHaveBeenCalledOnce();
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

  it("fails closed when a paused Loop v2 run cannot recover its pinned runtime", async () => {
    routeMocks.getThread.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000002",
      tenantId: context.tenantId,
      actorId: context.actorId,
      mode: "orchestrate",
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "yes",
        threadId: "00000000-0000-4000-8000-000000000002",
        resumeRunId: "00000000-0000-4000-8000-000000000001",
        requestId: "loop-v2-missing-pin-a",
      }),
    }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "The paused run could not be resumed by its pinned Loop v2 runtime.",
    );
    expect(routeMocks.runLoopV2ReadOnlyCanary).not.toHaveBeenCalled();
    expect(routeMocks.runLoopV2ModelText).not.toHaveBeenCalled();
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
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
    const runRequest = routeMocks.runLoopV2ReadOnlyCanary.mock.calls[0][0];
    expect(runRequest.runId).toBe(
      agentRequestRunId(context.tenantId, context.actorId, "loop-v2-list-runs-a"),
    );
    expect(routeMocks.runLoopV2ReadOnlyCanary).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: runRequest.runId,
        message: "Show my recent runs",
        agentId: "atlas",
        enrollment,
        executionScope: expect.objectContaining({
          purpose: "agent.loop.v2.read_only_canary",
          initiatingActorId: "actor-a",
          correlationId: runRequest.runId,
          causationId: "loop-v2-list-runs-a",
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
    const runRequest = routeMocks.runLoopV2ModelText.mock.calls[0][0];
    expect(routeMocks.runLoopV2ModelText).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: runRequest.runId,
        message,
        agentId: "atlas",
        enrollment,
        executionScope: expect.objectContaining({
          purpose: "agent.loop.v2.model_text_canary",
          initiatingActorId: "actor-a",
          correlationId: runRequest.runId,
          causationId: "loop-v2-model-text-a",
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(routeMocks.runLoopV2ReadOnlyCanary).not.toHaveBeenCalled();
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });

  it("passes the exact authenticated actor bridge into a Loop v2 root run", async () => {
    const personalContext = { ...context, actorId: context.auth.email };
    const enrollment = { enginePin: { engineVersionId: "loop-v2-test" } };
    routeMocks.authorizeRequest.mockResolvedValue(personalContext);
    routeMocks.createThread.mockResolvedValue({
      id: "thread-a",
      tenantId: personalContext.tenantId,
      actorId: personalContext.actorId,
    });
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
        requestId: "loop-v2-actor-bridge-a",
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    const runRequest = routeMocks.runLoopV2ReadOnlyCanary.mock.calls[0][0];
    expect(runRequest).toMatchObject({
      securityContext: personalContext,
      requestActorBinding: {
        canonicalActorId: `actor:${context.auth.userId}`,
        legacyOwnerActorIds: [context.auth.email],
        readableOwnerActorIds: [
          `actor:${context.auth.userId}`,
          context.auth.email,
        ],
      },
      executionScope: {
        initiatingActorId: context.auth.email,
        correlationId: runRequest.runId,
        causationId: "loop-v2-actor-bridge-a",
      },
    });
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
    const runRequest = routeMocks.runLoopV2ModelText.mock.calls[0][0];
    expect(routeMocks.runLoopV2ModelText).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: runRequest.runId,
        message,
        contextScope: "session",
        enrollment,
        executionScope: expect.objectContaining({
          purpose: "agent.loop.v2.context_text_canary",
          projectId: null,
          missionId: null,
          correlationId: runRequest.runId,
          causationId: "loop-v2-context-text-a",
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
  });

  it("keeps a resume on its pinned read-only canary while a voice session is pending", async () => {
    const enrollment = { enginePin: { engineVersionId: "loop-v2-test" } };
    const voiceThreadId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await seedRealtimeVoiceSession({
      threadId: voiceThreadId,
      sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      outcome: "sent",
    });
    routeMocks.getThread.mockResolvedValue({
      id: voiceThreadId,
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
        runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        threadId: voiceThreadId,
      };
      yield { type: "done", response: "Here are your recent runs." };
    });

    const response = await POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "yes",
        threadId: voiceThreadId,
        resumeRunId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        requestId: "loop-v2-voice-resume-a",
        strategy: "auto",
      }),
    }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("event: done");
    expect(resolveVoiceCommandGate).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: voiceThreadId }),
    );
    expect(routeMocks.runLoopV2ReadOnlyCanary).toHaveBeenCalled();
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
    expect(routeMocks.appendScopedDomainEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice.command_inferred" }),
    );
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
    const runRequest = routeMocks.runLoopV2ReadOnlyCanary.mock.calls[0][0];
    expect(routeMocks.runLoopV2ReadOnlyCanary).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "00000000-0000-4000-8000-000000000001",
        message: "yes",
        threadId: "00000000-0000-4000-8000-000000000002",
        resumeRunId: "00000000-0000-4000-8000-000000000001",
        enrollment,
        executionScope: expect.objectContaining({
          correlationId: "00000000-0000-4000-8000-000000000001",
          causationId: "loop-v2-clarification-a",
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(runRequest.runId).toBe(runRequest.executionScope.correlationId);
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
    // A resume continues its own run, so its requestId is not bound as a new
    // request.
    expect(routeMocks.appendScopedDomainEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: AGENT_REQUEST_BINDING_EVENT_TYPE }),
    );
  });
});

describe("agent direct-run memory formation", () => {
  it.each([
    ["decided on durable memory", ["durable"], true],
    ["withheld durable memory", ["withheld"], false],
    ["recorded no decision", [], false],
    ["recorded a decision without a formation value", [undefined], false],
    ["withheld durable memory after deciding on it", ["durable", "withheld"], false],
    ["decided on durable memory after withholding it", ["withheld", "durable"], false],
  ] as const)(
    "saves an inference candidate only when the run %s",
    async (_label, decisions, formsCandidate) => {
      routeMocks.runAgent.mockImplementation(async function* () {
        for (const memoryFormation of decisions) {
          yield {
            type: "harness",
            version: 1,
            memoryScope: "all",
            ...(memoryFormation ? { memoryFormation } : {}),
          };
        }
        yield { type: "run", runId: "run-memory-decision", threadId: "thread-a" };
        yield { type: "done", response: "Direct result." };
      });

      const response = await POST(new Request("http://asael.test/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Summarize the requested context.",
          requestId: "direct-memory-decision-a",
          strategy: "direct",
          agentId: "atlas",
        }),
      }));

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"type":"done"');
      if (formsCandidate) {
        expect(routeMocks.formAssistantInferenceCandidate).toHaveBeenCalledOnce();
        expect(routeMocks.formAssistantInferenceCandidate).toHaveBeenCalledWith(
          expect.objectContaining({
            requestId: "direct-memory-decision-a",
            runId: "run-memory-decision",
            response: "Direct result.",
          }),
        );
      } else {
        expect(routeMocks.formAssistantInferenceCandidate).not.toHaveBeenCalled();
      }
    },
  );
});

describe("agent request replay protection", () => {
  const replayContinuation = (executionId: string) => ({
    conversationItems: [{ role: "user", content: "Send the launch note." }],
    instructions: "test",
    response: "partial",
    toolSteps: 1,
    outputsBeforeApproval: [],
    pendingToolCall: {
      callId: "call_1",
      toolId: "computer.local",
      toolName: "This Mac",
      riskLevel: 2,
      executionId,
    },
    context: {
      tenantId: context.tenantId,
      actorId: context.actorId,
      role: "operator" as const,
    },
    createdAt: new Date().toISOString(),
  });

  /** Persists request bindings for real while other receipts stay mocked. */
  async function persistRequestBindings() {
    const events = await vi.importActual<typeof import("@/lib/events/store")>(
      "@/lib/events/store",
    );
    routeMocks.appendScopedDomainEvent.mockImplementation(async (input) =>
      input.type === AGENT_REQUEST_BINDING_EVENT_TYPE
        ? events.appendScopedDomainEvent(input)
        : undefined);
  }

  /** The runner records its run under the route's id, then settles it. */
  function runAgentRecording(
    settle: (runId: string) => Promise<unknown> = async () => undefined,
  ) {
    routeMocks.runAgent.mockImplementation(async function* (request: {
      runId: string;
      tenantId: string;
      actorId: string;
      threadId?: string;
    }) {
      const store = await import("@/lib/runs/store");
      const run = await store.createAgentRun({
        id: request.runId,
        tenantId: request.tenantId,
        actorId: request.actorId,
        threadId: request.threadId,
        mode: "orchestrate",
        prompt: "replay test",
        messages: [{ role: "user", content: "replay test" }],
      });
      await settle(run.id);
      yield { type: "run", runId: run.id, threadId: request.threadId };
      yield { type: "done", response: "First attempt answer." };
    });
  }

  function send(
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) {
    return POST(new Request("http://asael.test/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    }));
  }

  it("replays a completed request instead of running it again", async () => {
    await persistRequestBindings();
    const requestId = "replay-completed-a";
    const runId = agentRequestRunId(context.tenantId, context.actorId, requestId);
    runAgentRecording(async (id) => {
      const store = await import("@/lib/runs/store");
      await store.completeAgentRun(id, "Recorded answer.", undefined, {
        tenantId: context.tenantId,
      });
    });
    const body = {
      message: "Summarize my week.",
      requestId,
      strategy: "direct",
    };

    const first = await send(body);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-asael-run-id")).toBe(runId);
    expect(await first.text()).toContain('"type":"done"');
    expect(routeMocks.createThread).toHaveBeenCalledWith(expect.objectContaining({
      id: agentRequestThreadId(context.tenantId, context.actorId, requestId),
    }));
    expect(routeMocks.runAgent.mock.calls[0][0].runId).toBe(runId);

    // The client learns the new thread from the first attempt's run event and
    // names it on the retry; that is still the same instruction.
    for (const retry of [
      body,
      {
        ...body,
        threadId: agentRequestThreadId(context.tenantId, context.actorId, requestId),
      },
    ]) {
      const replayed = await send(retry);
      expect(replayed.status).toBe(200);
      expect(replayed.headers.get("content-type")).toContain("text/event-stream");
      const stream = await replayed.text();
      expect(stream).toContain(`"runId":"${runId}"`);
      expect(stream).toContain('"label":"Replayed"');
      expect(stream).toContain('"response":"Recorded answer."');
    }
    expect(routeMocks.runAgent).toHaveBeenCalledTimes(1);
    expect(routeMocks.resolveSemanticIntent).toHaveBeenCalledTimes(1);
    expect(routeMocks.createThread).toHaveBeenCalledTimes(1);
    expect(routeMocks.appendThreadTurn).toHaveBeenCalledTimes(1);
  });

  it("refuses a requestId reused for a different instruction", async () => {
    await persistRequestBindings();
    const requestId = "replay-reused-a";
    runAgentRecording();
    const first = await send({
      message: "Summarize my week.",
      requestId,
      strategy: "direct",
    });
    await first.text();

    for (const changed of [
      { message: "Delete my calendar.", requestId, strategy: "direct" },
      { message: "Summarize my week.", requestId, strategy: "direct", agentId: "nova" },
    ]) {
      const reused = await send(changed);
      expect(reused.status).toBe(409);
      await expect(reused.json()).resolves.toMatchObject({
        code: "request_id_reused",
      });
    }
    expect(routeMocks.runAgent).toHaveBeenCalledTimes(1);
  });

  it("follows a request whose run is still going instead of starting it again", async () => {
    await persistRequestBindings();
    const requestId = "replay-running-a";
    const runId = agentRequestRunId(context.tenantId, context.actorId, requestId);
    let seenEvent: { seq?: number } | undefined;
    runAgentRecording(async (id) => {
      const store = await import("@/lib/runs/store");
      seenEvent = await store.appendRunEvent(
        id,
        { type: "status", label: "Reading the calendar" },
        { tenantId: context.tenantId },
      );
      await store.appendRunEvent(
        id,
        { type: "status", label: "Drafting the summary" },
        { tenantId: context.tenantId },
      );
    });
    const body = { message: "Summarize my week.", requestId, strategy: "direct" };
    await (await send(body)).text();

    // The retry names the last event it saw and picks up after it.
    const retry = await send(body, { "last-event-id": String(seenEvent?.seq) });
    expect(retry.status).toBe(200);
    expect(retry.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(retry.headers.get("x-asael-run-id")).toBe(runId);
    const reader = retry.body!.getReader();
    const decoder = new TextDecoder();
    let stream = "";
    while (!stream.includes("Drafting the summary")) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      stream += decoder.decode(chunk.value, { stream: true });
    }
    // The header names the thread the first attempt's run belongs to.
    const threadId = routeMocks.runAgent.mock.calls[0][0].threadId;
    expect(threadId).toEqual(expect.any(String));
    expect(stream).toContain(`"type":"run","runId":"${runId}","threadId":"${threadId}"`);
    expect(stream).not.toContain("Reading the calendar");

    const store = await import("@/lib/runs/store");
    await store.completeAgentRun(runId, "Finished while followed.", undefined, {
      tenantId: context.tenantId,
    });
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stream += decoder.decode(chunk.value, { stream: true });
    }
    expect(stream).toContain('"type":"done","response":"Finished while followed."');
    expect(routeMocks.runAgent).toHaveBeenCalledTimes(1);
  });

  it("stops following a request's run once the retry disconnects", async () => {
    await persistRequestBindings();
    const body = {
      message: "Summarize my week.",
      requestId: "replay-running-disconnect-a",
      strategy: "direct",
    };
    runAgentRecording();
    await (await send(body)).text();

    const disconnect = new AbortController();
    const retry = await send(body, {}, disconnect.signal);
    const reader = retry.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    disconnect.abort();

    // The run is still going, so a tail that missed the disconnect would keep
    // polling it well past this.
    const next = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve("still following"), 2_000)),
    ]);
    expect(next).toEqual({ done: true, value: undefined });
  });

  it.each([
    [
      "paused for approval",
      async (runId: string) => {
        const store = await import("@/lib/runs/store");
        await store.markAgentRunWaitingForApproval(runId, {
          response: "partial",
          continuation: replayContinuation("exec-replay-approval"),
        });
      },
      ['"type":"waiting_approval"', '"executionId":"exec-replay-approval"'],
    ],
    [
      "stopped",
      async (runId: string) => {
        const store = await import("@/lib/runs/store");
        await store.cancelAgentRun(runId, "Canceled by the operator.", {
          tenantId: context.tenantId,
        });
      },
      ['"type":"canceled"', "was not run again"],
    ],
    [
      "failed",
      async (runId: string) => {
        const store = await import("@/lib/runs/store");
        await store.failAgentRun(runId, "The provider was unavailable.", {
          tenantId: context.tenantId,
        });
      },
      ['"type":"error"', "The provider was unavailable."],
    ],
  ] as const)("replays a request whose run %s", async (label, settle, expected) => {
    await persistRequestBindings();
    const requestId = `replay-${label.replaceAll(" ", "-")}-a`;
    runAgentRecording(settle);
    const body = { message: "Send the launch note.", requestId, strategy: "direct" };
    await (await send(body)).text();

    const replayed = await send(body);
    expect(replayed.status).toBe(200);
    const stream = await replayed.text();
    for (const fragment of expected) expect(stream).toContain(fragment);
    expect(stream).not.toContain('"type":"done"');
    expect(routeMocks.runAgent).toHaveBeenCalledTimes(1);
  });

  it("replays the durable workflow a request already started", async () => {
    await persistRequestBindings();
    const requestId = "replay-durable-a";
    routeMocks.resolveSemanticIntent.mockResolvedValue(durableWorkflowIntent());
    routeMocks.createMission.mockResolvedValue({
      id: "mission-replay-durable",
      title: "Coordinate the launch",
      objective: "Coordinate the launch across the team.",
      priority: "high",
      status: "queued",
    });
    vi.mocked(prepareDurableSpecialistDelegation).mockResolvedValueOnce([]);
    vi.mocked(scheduleDurableSpecialistDrain).mockReturnValueOnce(undefined);
    const body = {
      message: "Coordinate the launch across the team.",
      requestId,
      strategy: "durable",
    };

    const first = await send(body);
    expect(first.status).toBe(200);
    const firstStream = await first.text();
    expect(firstStream).toContain("event: delegated");
    expect(routeMocks.appendThreadTurn).toHaveBeenCalledWith(expect.objectContaining({
      id: agentRequestDelegatedTurnId(
        context.tenantId,
        context.actorId,
        "thread-a",
        requestId,
      ),
      role: "assistant",
    }));
    const createdWorkflow = await vi.mocked(createWorkflowRun).mock.results[0]?.value;

    const replayed = await send(body);
    expect(replayed.status).toBe(200);
    const stream = await replayed.text();
    expect(stream).toContain("event: delegated");
    expect(stream).toContain(`"workflowId":"${createdWorkflow.run.id}"`);
    expect(stream).toContain('"threadId":"thread-a"');
    expect(stream).toContain("Replayed the workflow this request already started.");
    expect(createWorkflowRun).toHaveBeenCalledTimes(1);
    expect(routeMocks.createMission).toHaveBeenCalledTimes(1);
    expect(routeMocks.resolveSemanticIntent).toHaveBeenCalledTimes(1);
  });

  it("derives identities from an Idempotency-Key and leaves server-identified requests alone", async () => {
    await persistRequestBindings();
    runAgentRecording();
    await (await send(
      { message: "Summarize my week.", strategy: "direct" },
      { "Idempotency-Key": "replay-header-a" },
    )).text();
    expect(routeMocks.runAgent.mock.calls[0][0].runId).toBe(
      agentRequestRunId(context.tenantId, context.actorId, "replay-header-a"),
    );
    expect(routeMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: AGENT_REQUEST_BINDING_EVENT_TYPE }),
    );

    routeMocks.appendScopedDomainEvent.mockClear();
    routeMocks.createThread.mockClear();
    routeMocks.appendThreadTurn.mockClear();
    await (await send({ message: "Summarize my week.", strategy: "direct" })).text();
    expect(routeMocks.runAgent.mock.calls[1][0].runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(routeMocks.appendScopedDomainEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: AGENT_REQUEST_BINDING_EVENT_TYPE }),
    );
    expect(routeMocks.createThread.mock.calls[0][0]).not.toHaveProperty("id");
    expect(routeMocks.appendThreadTurn.mock.calls[0][0]).not.toHaveProperty("id");
  });

  it("fails closed when the request binding cannot be recorded", async () => {
    routeMocks.appendScopedDomainEvent.mockImplementation(async (input) => {
      if (input.type === AGENT_REQUEST_BINDING_EVENT_TYPE) {
        throw new Error("event store offline");
      }
    });
    runAgentRecording();

    const response = await send({
      message: "Summarize my week.",
      requestId: "replay-outage-a",
      strategy: "direct",
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(routeMocks.runAgent).not.toHaveBeenCalled();
    expect(routeMocks.createThread).not.toHaveBeenCalled();
    expect(routeMocks.resolveSemanticIntent).not.toHaveBeenCalled();
  });

  it("lets the voice gate recognize the request's own earlier consumption", async () => {
    runAgentRecording();
    await (await send({
      message: "Summarize my week.",
      requestId: "replay-voice-a",
      strategy: "direct",
    })).text();
    expect(resolveVoiceCommandGate).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "replay-voice-a" }),
    );
  });

  it("keys the semantic receipt by its decision", async () => {
    runAgentRecording();
    await (await send({
      message: "Summarize my week.",
      requestId: "replay-semantic-a",
      strategy: "direct",
    })).text();
    const receipt = routeMocks.appendScopedDomainEvent.mock.calls
      .map(([input]) => input)
      .find((input) => input.type === "intent.semantic_resolved");
    expect(receipt).toBeDefined();
    expect(receipt.id).toBe(`intent-semantic:${createHash("sha256")
      .update(
        `${context.tenantId}\u0000${context.actorId}\u0000replay-semantic-a\u0000${canonicalJsonSha256(receipt.payload)}`,
      )
      .digest("hex")}`);
  });

  it("keys the context pin receipt by its pins", async () => {
    runAgentRecording();
    vi.mocked(resolveCommandContextReferences).mockResolvedValueOnce({
      schemaVersion: 1,
      selectionSha256: "a".repeat(64),
      contextBlockSha256: "b".repeat(64),
      receiptSha256: "c".repeat(64),
      contextBlock: "Pinned skill: weekly summary.",
      pins: [{ kind: "skill", id: "skill-weekly", pinSha256: "d".repeat(64) }],
      kindCounts: { skill: 1 },
    });
    await (await send({
      message: "Summarize my week.",
      requestId: "replay-pin-a",
      strategy: "direct",
      contextReferences: [{ kind: "skill", id: "skill-weekly" }],
    })).text();
    const receipt = routeMocks.appendScopedDomainEvent.mock.calls
      .map(([input]) => input)
      .find((input) => input.type === "command.context.pinned");
    expect(receipt).toBeDefined();
    expect(receipt.payload).toMatchObject({ receiptSha256: "c".repeat(64) });
    expect(receipt.id).toBe(`command-context:${createHash("sha256")
      .update(
        `${context.tenantId}\u0000${context.actorId}\u0000replay-pin-a\u0000${canonicalJsonSha256(receipt.payload)}`,
      )
      .digest("hex")}`);
  });

  it("acknowledges the approval decision the stored workflow kept", async () => {
    await persistRequestBindings();
    routeMocks.resolveSemanticIntent.mockResolvedValue(durableWorkflowIntent());
    routeMocks.createMission.mockResolvedValue({
      id: "mission-replay-ack",
      title: "Coordinate the launch",
      objective: "Coordinate the launch across the team.",
      priority: "high",
      status: "queued",
    });
    vi.mocked(prepareDurableSpecialistDelegation).mockResolvedValueOnce([]);
    vi.mocked(scheduleDurableSpecialistDrain).mockReturnValueOnce(undefined);
    // A concurrent first attempt already created the workflow under the other
    // approval decision.
    vi.mocked(createWorkflowRun).mockImplementationOnce(async (input) => {
      const actual = await vi.importActual<typeof import("@/lib/workflows/store")>(
        "@/lib/workflows/store",
      );
      return actual.createWorkflowRun({
        ...input,
        requireApproval: !input.requireApproval,
      });
    });

    const stream = await (await send({
      message: "Coordinate the launch across the team.",
      requestId: "replay-durable-ack",
      strategy: "durable",
    })).text();
    const computed = vi.mocked(createWorkflowRun).mock.calls[0][0].requireApproval;
    const stored = await vi.mocked(createWorkflowRun).mock.results[0]?.value;
    expect(stored.run.approvalRequired).toBe(!computed);
    const acknowledgement = durableWorkflowAcknowledgement(stored.run.approvalRequired);
    expect(stream).toContain(JSON.stringify(acknowledgement).slice(1, -1));
    expect(routeMocks.appendThreadTurn).toHaveBeenCalledWith(expect.objectContaining({
      role: "assistant",
      content: acknowledgement,
    }));
  });
});
