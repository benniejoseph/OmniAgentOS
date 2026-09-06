import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
  appendThreadTurn: vi.fn(),
  authorizeRequest: vi.fn(),
  checkSharedRateLimit: vi.fn(),
  createThread: vi.fn(),
  getAgentPerformance: vi.fn(),
  getThread: vi.fn(),
  listThreadTurns: vi.fn(),
  resolveLoopV2ModelTextEnrollment: vi.fn(),
  resolveLoopV2ReadOnlyCanaryEnrollment: vi.fn(),
  resolveSemanticIntent: vi.fn(),
  runAgent: vi.fn(),
  runLoopV2ModelText: vi.fn(),
  runLoopV2ReadOnlyCanary: vi.fn(),
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

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: routeMocks.appendScopedDomainEvent,
}));

vi.mock("@/lib/threads/store", () => ({
  appendThreadTurn: routeMocks.appendThreadTurn,
  createThread: routeMocks.createThread,
  getThread: routeMocks.getThread,
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
  resolveLoopV2ModelTextEnrollment:
    routeMocks.resolveLoopV2ModelTextEnrollment,
  runLoopV2ModelText: routeMocks.runLoopV2ModelText,
}));

vi.mock("@/lib/orchestration/semantic-intent-resolver", () => ({
  resolveSemanticIntent: routeMocks.resolveSemanticIntent,
}));

import { POST } from "@/app/api/agent/route";

const context = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  role: "admin" as const,
  source: "session" as const,
};

beforeEach(() => {
  routeMocks.appendScopedDomainEvent.mockReset().mockResolvedValue(undefined);
  routeMocks.appendThreadTurn.mockReset()
    .mockResolvedValueOnce({ id: "turn-user" })
    .mockResolvedValueOnce({ id: "turn-assistant" });
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.checkSharedRateLimit.mockReset().mockResolvedValue({ allowed: true });
  routeMocks.createThread.mockReset().mockResolvedValue({
    id: "thread-a",
    tenantId: context.tenantId,
    actorId: context.actorId,
  });
  routeMocks.getAgentPerformance.mockReset().mockResolvedValue([]);
  routeMocks.getThread.mockReset().mockResolvedValue(null);
  routeMocks.listThreadTurns.mockReset().mockResolvedValue([]);
  routeMocks.resolveLoopV2ReadOnlyCanaryEnrollment.mockReset()
    .mockResolvedValue(null);
  routeMocks.resolveLoopV2ModelTextEnrollment.mockReset()
    .mockResolvedValue(null);
  routeMocks.resolveSemanticIntent.mockReset()
    .mockImplementation(async ({ baseline }) => ({
      decision: baseline,
      capabilitySearchQuery: "",
      receipt: {
        schemaVersion: 1,
        policyVersion: "semantic-intent-policy-v1",
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
        executingPrincipalId: "atlas",
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
        policyVersion: "semantic-intent-policy-v1",
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
        semanticRouting: {
          capabilitySearchQuery: "list github issues",
          matchedCapabilityIds: ["github.issues.list"],
          policyVersion: "semantic-intent-policy-v1",
        },
      }),
      expect.any(AbortSignal),
    );
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
