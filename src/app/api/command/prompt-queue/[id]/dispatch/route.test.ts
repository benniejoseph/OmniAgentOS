import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestScopeDepth: 0,
  authorizeRequest: vi.fn(),
  claimPromptQueueDispatch: vi.fn(),
  persistReceipt: vi.fn(),
  runGovernedAgent: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    <TArgs extends unknown[], TResult>(
      handler: (...args: TArgs) => TResult | Promise<TResult>,
    ) =>
      async (...args: TArgs) => {
        mocks.requestScopeDepth += 1;
        try {
          return await handler(...args);
        } finally {
          mocks.requestScopeDepth -= 1;
        }
      },
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));

vi.mock("@/lib/command/prompt-queue-store", () => ({
  claimPromptQueueDispatch: mocks.claimPromptQueueDispatch,
}));

vi.mock("@/lib/command/prompt-queue-lifecycle", () => ({
  persistPromptQueueDispatchReceipt: mocks.persistReceipt,
}));

vi.mock("@/app/api/agent/route", () => ({
  POST: mocks.runGovernedAgent,
}));

vi.mock("@/app/api/command/prompt-queue/http", () => ({
  promptQueueAuthority: () => ({
    tenantId: "tenant-one",
    ownerActorId: "actor:owner-one",
    requestActorId: "owner@example.test",
    sessionId: "session-one",
    executionScope: { purpose: "prompt_queue.dispatch" },
  }),
  promptQueueErrorResponse: (error: unknown) => {
    throw error;
  },
}));

import { POST } from "@/app/api/command/prompt-queue/[id]/dispatch/route";

const itemId = "11111111-1111-4111-8111-111111111111";
const upstreamSse = [
  "event: run",
  'data: {"type":"run","runId":"run-one","threadId":"thread-one"}',
  "",
  "event: done",
  'data: {"type":"done","response":"exact upstream bytes"}',
  "",
  "",
].join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestScopeDepth = 0;
  mocks.authorizeRequest.mockResolvedValue({
    tenantId: "tenant-one",
    actorId: "owner@example.test",
    role: "admin",
    source: "session",
  });
  mocks.claimPromptQueueDispatch.mockResolvedValue({
    item: {
      id: itemId,
      prompt: "Return exactly queue scope released.",
      mode: "execute",
      strategy: "direct",
      agent: { logicalAgentId: "atlas" },
      target: {
        threadId: null,
        missionId: null,
        projectId: null,
        executionTarget: "asael",
      },
      lifecycleRevision: 7,
    },
    dispatchToken: "private-dispatch-token",
  });
  mocks.persistReceipt.mockResolvedValue({ status: "applied" });
  mocks.runGovernedAgent.mockImplementation(async (request: Request) => {
    if (mocks.requestScopeDepth !== 0) {
      throw new Error("Agent stream started inside dispatch admission scope");
    }
    expect(request.headers.get("x-asael-prompt-queue-item")).toBe(itemId);
    expect(request.headers.get("x-asael-prompt-queue-token")).toBe(
      "private-dispatch-token",
    );
    return new Response(upstreamSse, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  });
});

describe("prompt queue dispatch forwarding", () => {
  it("releases admission scope and forwards the Agent body without an outer observer", async () => {
    const response = await POST(dispatchRequest(), {
      params: Promise.resolve({ id: itemId }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-asael-prompt-queue-item")).toBe(itemId);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.text()).resolves.toBe(upstreamSse);
    expect(mocks.runGovernedAgent).toHaveBeenCalledOnce();
    expect(mocks.persistReceipt).not.toHaveBeenCalled();
    expect(mocks.requestScopeDepth).toBe(0);
  });

  it("uses the shared safe receipt helper when Agent admission returns non-2xx", async () => {
    mocks.runGovernedAgent.mockResolvedValueOnce(Response.json(
      { error: "not accepted" },
      { status: 409 },
    ));

    const response = await POST(dispatchRequest(), {
      params: Promise.resolve({ id: itemId }),
    });

    expect(response.status).toBe(409);
    expect(mocks.persistReceipt).toHaveBeenCalledOnce();
    expect(mocks.persistReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId,
        tenantId: "tenant-one",
        ownerActorId: "actor:owner-one",
      }),
      {
        terminal: "failed",
        progressLabel: "Governed execution was not accepted",
        failureCode: "agent_route_409",
      },
    );
  });

  it("uses the shared safe receipt helper when Agent admission throws", async () => {
    const unavailable = new Error("Agent route unavailable");
    mocks.runGovernedAgent.mockRejectedValueOnce(unavailable);

    await expect(POST(dispatchRequest(), {
      params: Promise.resolve({ id: itemId }),
    })).rejects.toBe(unavailable);
    expect(mocks.persistReceipt).toHaveBeenCalledOnce();
    expect(mocks.persistReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ itemId }),
      {
        terminal: "failed",
        progressLabel: "Governed execution could not start",
        failureCode: "agent_route_unavailable",
      },
    );
  });
});

function dispatchRequest() {
  return new Request(
    `https://asael.test/api/command/prompt-queue/${itemId}/dispatch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 6, force: false }),
    },
  );
}
