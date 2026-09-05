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
  runAgent: vi.fn(),
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
  routeMocks.runAgent.mockReset();
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
