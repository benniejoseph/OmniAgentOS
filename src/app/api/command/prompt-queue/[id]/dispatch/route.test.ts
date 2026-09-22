import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestScopeDepth: 0,
  authorizeRequest: vi.fn(),
  claimPromptQueueDispatch: vi.fn(),
  persistReceipt: vi.fn(),
  fetchAgent: vi.fn(),
  expectedAgentUrl: "https://asael.test/api/agent",
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
  mocks.expectedAgentUrl = "https://asael.test/api/agent";
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
  mocks.fetchAgent.mockImplementation(async (
    request: Request,
    init?: RequestInit,
  ) => {
    if (mocks.requestScopeDepth !== 0) {
      throw new Error("Agent stream started inside dispatch admission scope");
    }
    expect(request.url).toBe(mocks.expectedAgentUrl);
    expect(request.headers.get("authorization")).toBe("Bearer native-token");
    expect(request.headers.get("accept-encoding")).toBe("identity");
    expect(request.headers.get("x-asael-prompt-queue-item")).toBe(itemId);
    expect(request.headers.get("x-asael-prompt-queue-token")).toBe(
      "private-dispatch-token",
    );
    expect(request.headers.has("host")).toBe(false);
    expect(request.headers.has("x-forwarded-host")).toBe(false);
    expect(init?.redirect).toBe("manual");
    return new Response(upstreamSse, {
      headers: {
        connection: "keep-alive",
        "content-encoding": "gzip",
        "content-length": "999",
        "content-type": "text/event-stream; charset=utf-8",
      },
    });
  });
  vi.stubGlobal("fetch", mocks.fetchAgent);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("prompt queue dispatch forwarding", () => {
  it("releases admission scope and forwards the Agent body without an outer observer", async () => {
    const response = await POST(dispatchRequest(), {
      params: Promise.resolve({ id: itemId }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-asael-prompt-queue-item")).toBe(itemId);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    await expect(response.text()).resolves.toBe(upstreamSse);
    expect(mocks.fetchAgent).toHaveBeenCalledOnce();
    expect(mocks.persistReceipt).not.toHaveBeenCalled();
    expect(mocks.requestScopeDepth).toBe(0);
  });

  it("uses the shared safe receipt helper when Agent admission returns non-2xx", async () => {
    mocks.fetchAgent.mockResolvedValueOnce(Response.json(
      { error: "not accepted" },
      {
        status: 409,
        headers: {
          "content-encoding": "gzip",
          "content-length": "999",
        },
      },
    ));

    const response = await POST(dispatchRequest(), {
      params: Promise.resolve({ id: itemId }),
    });

    expect(response.status).toBe(409);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-asael-prompt-queue-item")).toBe(itemId);
    await expect(response.json()).resolves.toEqual({ error: "not accepted" });
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

  it("does not forward an Agent redirect or its destination", async () => {
    mocks.fetchAgent.mockResolvedValueOnce(new Response(null, {
      status: 307,
      headers: { location: "https://untrusted.example.test/sign-in" },
    }));

    const response = await POST(dispatchRequest(), {
      params: Promise.resolve({ id: itemId }),
    });

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: "Governed execution unavailable",
      message: "The governed Agent service returned an unexpected redirect.",
    });
    expect(mocks.persistReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ itemId }),
      {
        terminal: "failed",
        progressLabel: "Governed execution was not accepted",
        failureCode: "agent_route_307",
      },
    );
  });

  it("uses the shared safe receipt helper when Agent admission throws", async () => {
    const unavailable = new Error("Agent route unavailable");
    mocks.fetchAgent.mockRejectedValueOnce(unavailable);

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

  it("rejects a successful non-SSE Agent response and closes the claim", async () => {
    const cancel = vi.fn();
    mocks.fetchAgent.mockResolvedValueOnce(new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true}'));
        },
        cancel,
      }),
      { headers: { "content-type": "application/json" } },
    ));

    const response = await POST(dispatchRequest(), {
      params: Promise.resolve({ id: itemId }),
    });

    expect(response.status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({
      error: "Governed execution unavailable",
      message: "The governed Agent service did not return a live event stream.",
    });
    expect(mocks.persistReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ itemId }),
      {
        terminal: "failed",
        progressLabel: "Governed execution returned an invalid stream",
        failureCode: "agent_route_invalid_content_type",
      },
    );
  });

  it("fences canonical production forwarding with the current revision", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_URL", "current-deployment.vercel.app");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "revision-current");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://asael.bennierichard.com");
    mocks.expectedAgentUrl = "https://asael.bennierichard.com/api/agent";

    const response = await POST(
      dispatchRequest("https://asael.bennierichard.com"),
      { params: Promise.resolve({ id: itemId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.fetchAgent).toHaveBeenCalledOnce();
    const forwarded = mocks.fetchAgent.mock.calls[0]?.[0] as Request;
    expect(
      forwarded.headers.get("x-asael-prompt-queue-revision"),
    ).toBe("revision-current");
  });

  it("does not claim a production queue item without a release revision", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_URL", "current-deployment.vercel.app");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://asael.bennierichard.com");

    const response = await POST(
      dispatchRequest("https://asael.bennierichard.com"),
      { params: Promise.resolve({ id: itemId }) },
    );

    expect(response.status).toBe(503);
    expect(mocks.claimPromptQueueDispatch).not.toHaveBeenCalled();
    expect(mocks.fetchAgent).not.toHaveBeenCalled();
  });

  it("rejects an untrusted production origin before claiming the queue item", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_URL", "trusted-deployment.vercel.app");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://asael.bennierichard.com");

    const response = await POST(dispatchRequest(), {
      params: Promise.resolve({ id: itemId }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid prompt queue dispatch origin",
      message: "The queued command must be dispatched through this Asael deployment.",
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledOnce();
    expect(mocks.claimPromptQueueDispatch).not.toHaveBeenCalled();
    expect(mocks.fetchAgent).not.toHaveBeenCalled();
  });
});

function dispatchRequest(origin = "https://asael.test") {
  return new Request(
    `${origin}/api/command/prompt-queue/${itemId}/dispatch`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer native-token",
        "content-type": "application/json",
        host: "untrusted-forwarded-host.test",
        "x-forwarded-host": "untrusted-forwarded-host.test",
      },
      body: JSON.stringify({ expectedRevision: 6, force: false }),
    },
  );
}
