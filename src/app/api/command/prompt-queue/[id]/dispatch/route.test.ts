import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestScopeDepth: 0,
  actorScopeDepth: 0,
  authorizeRequest: vi.fn(),
  claimPromptQueueDispatch: vi.fn(),
  recordPromptQueueDispatchProgress: vi.fn(),
  runGovernedAgent: vi.fn(),
  runWithDatabaseActorScope: vi.fn(),
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
  runWithDatabaseActorScope: (
    tenantId: string,
    actorIds: readonly string[],
    operation: () => unknown,
  ) => mocks.runWithDatabaseActorScope(tenantId, actorIds, operation),
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));

vi.mock("@/lib/command/prompt-queue-store", () => ({
  claimPromptQueueDispatch: mocks.claimPromptQueueDispatch,
  recordPromptQueueDispatchProgress: mocks.recordPromptQueueDispatchProgress,
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
const runId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestScopeDepth = 0;
  mocks.actorScopeDepth = 0;
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
  mocks.runWithDatabaseActorScope.mockImplementation(async (
    _tenantId: string,
    _actorIds: readonly string[],
    operation: () => unknown,
  ) => {
    if (mocks.requestScopeDepth !== 0) {
      throw new Error("progress attempted while dispatch request scope was active");
    }
    mocks.actorScopeDepth += 1;
    try {
      return await operation();
    } finally {
      mocks.actorScopeDepth -= 1;
    }
  });
  mocks.recordPromptQueueDispatchProgress.mockImplementation(async () => {
    if (mocks.requestScopeDepth !== 0 || mocks.actorScopeDepth !== 1) {
      throw new Error("progress did not use its own actor database scope");
    }
  });
  mocks.runGovernedAgent.mockImplementation(async () => {
    if (mocks.requestScopeDepth !== 0) {
      throw new Error("Agent stream started inside dispatch request scope");
    }
    return sseResponse([
      { type: "run", runId, threadId },
      { type: "done", response: "queue scope released" },
    ]);
  });
});

describe("prompt queue dispatch stream scope", () => {
  it("releases admission scope before Agent streaming and scopes each progress write", async () => {
    const response = await POST(new Request(
      `https://asael.test/api/command/prompt-queue/${itemId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 6, force: false }),
      },
    ), { params: Promise.resolve({ id: itemId }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-asael-prompt-queue-item")).toBe(itemId);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.text()).resolves.toContain("queue scope released");

    expect(mocks.runGovernedAgent).toHaveBeenCalledOnce();
    expect(mocks.runWithDatabaseActorScope).toHaveBeenCalledTimes(2);
    for (const call of mocks.runWithDatabaseActorScope.mock.calls) {
      expect(call[0]).toBe("tenant-one");
      expect(call[1]).toEqual(["actor:owner-one"]);
    }
    expect(mocks.recordPromptQueueDispatchProgress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        itemId,
        tenantId: "tenant-one",
        ownerActorId: "actor:owner-one",
        runId,
        threadId,
        progressLabel: "Governed run accepted",
      }),
    );
    expect(mocks.recordPromptQueueDispatchProgress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        itemId,
        runId,
        threadId,
        terminal: "completed",
        progressLabel: "Governed run completed",
      }),
    );
    expect(mocks.requestScopeDepth).toBe(0);
    expect(mocks.actorScopeDepth).toBe(0);
  });

  it("forwards terminal SSE before a held accepted-progress write settles", async () => {
    let releaseAcceptedWrite: () => void = () => undefined;
    let acceptedWriteReleased = false;
    const heldAcceptedWrite = new Promise<void>((resolve) => {
      releaseAcceptedWrite = () => {
        acceptedWriteReleased = true;
        resolve();
      };
    });
    let writeCount = 0;
    mocks.recordPromptQueueDispatchProgress.mockImplementation(async () => {
      if (mocks.requestScopeDepth !== 0 || mocks.actorScopeDepth !== 1) {
        throw new Error("progress did not use its own actor database scope");
      }
      writeCount += 1;
      if (writeCount === 1) await heldAcceptedWrite;
    });

    const response = await POST(new Request(
      `https://asael.test/api/command/prompt-queue/${itemId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 6, force: false }),
      },
    ), { params: Promise.resolve({ id: itemId }) });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const acceptedChunk = await reader!.read();
    const terminalChunk = await reader!.read();
    expect(new TextDecoder().decode(acceptedChunk.value)).toContain(
      `\"runId\":\"${runId}\"`,
    );
    expect(new TextDecoder().decode(terminalChunk.value)).toContain(
      "\"type\":\"done\"",
    );
    expect(acceptedWriteReleased).toBe(false);
    expect(mocks.recordPromptQueueDispatchProgress).toHaveBeenCalledOnce();

    let endSettled = false;
    const end = reader!.read().then((result) => {
      endSettled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(endSettled).toBe(false);

    releaseAcceptedWrite();
    await expect(end).resolves.toMatchObject({ done: true });
    expect(mocks.recordPromptQueueDispatchProgress).toHaveBeenCalledTimes(2);
    expect(mocks.recordPromptQueueDispatchProgress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        runId,
        progressLabel: "Governed run accepted",
      }),
    );
    expect(mocks.recordPromptQueueDispatchProgress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runId,
        terminal: "completed",
        progressLabel: "Governed run completed",
      }),
    );
  });

  it("closes cleanly when a terminal receipt recovers an earlier progress failure", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let writeCount = 0;
    mocks.recordPromptQueueDispatchProgress.mockImplementation(async () => {
      writeCount += 1;
      if (writeCount === 1) {
        throw new Error("database progress write failed");
      }
    });

    try {
      const response = await POST(new Request(
        `https://asael.test/api/command/prompt-queue/${itemId}/dispatch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: 6, force: false }),
        },
      ), { params: Promise.resolve({ id: itemId }) });
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      await expect(reader!.read()).resolves.toMatchObject({ done: false });
      await expect(reader!.read()).resolves.toMatchObject({ done: false });
      await expect(reader!.read()).resolves.toMatchObject({ done: true });

      expect(mocks.recordPromptQueueDispatchProgress).toHaveBeenCalledTimes(2);
      expect(mocks.recordPromptQueueDispatchProgress).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          runId,
          terminal: "completed",
          progressLabel: "Governed run completed",
        }),
      );
      expect(logged).toHaveBeenCalledWith(
        "Prompt queue dispatch progress persistence failed.",
        expect.stringContaining(`\"itemId\":\"${itemId}\"`),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("fails stream settlement when the terminal receipt cannot be persisted", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let writeCount = 0;
    mocks.recordPromptQueueDispatchProgress.mockImplementation(async () => {
      writeCount += 1;
      if (writeCount >= 2) {
        throw new Error("terminal progress write failed");
      }
    });

    try {
      const response = await POST(new Request(
        `https://asael.test/api/command/prompt-queue/${itemId}/dispatch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: 6, force: false }),
        },
      ), { params: Promise.resolve({ id: itemId }) });
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      await expect(reader!.read()).resolves.toMatchObject({ done: false });
      await expect(reader!.read()).resolves.toMatchObject({ done: false });
      await expect(reader!.read()).rejects.toThrow(
        "Prompt queue dispatch progress could not be persisted.",
      );

      expect(mocks.recordPromptQueueDispatchProgress).toHaveBeenCalledTimes(2);
      expect(logged).toHaveBeenCalledWith(
        "Prompt queue dispatch progress persistence failed.",
        expect.stringContaining(`\"itemId\":\"${itemId}\"`),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("retries one pre-COMMIT connection close while persisting the terminal receipt", async () => {
    let writeCount = 0;
    mocks.recordPromptQueueDispatchProgress.mockImplementation(async () => {
      writeCount += 1;
      if (writeCount === 2) {
        throw Object.assign(new Error("closed before COMMIT"), {
          code: "DATABASE_CONNECTION_CLOSED",
        });
      }
    });

    const response = await POST(new Request(
      `https://asael.test/api/command/prompt-queue/${itemId}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 6, force: false }),
      },
    ), { params: Promise.resolve({ id: itemId }) });

    await expect(response.text()).resolves.toContain("queue scope released");
    expect(mocks.recordPromptQueueDispatchProgress).toHaveBeenCalledTimes(3);
    expect(mocks.recordPromptQueueDispatchProgress).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        runId,
        terminal: "completed",
        progressLabel: "Governed run completed",
      }),
    );
  });

  it("does not replay a terminal receipt with an unknown COMMIT outcome", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let writeCount = 0;
    mocks.recordPromptQueueDispatchProgress.mockImplementation(async () => {
      writeCount += 1;
      if (writeCount === 2) {
        throw Object.assign(new Error("COMMIT acknowledgement was lost"), {
          code: "DATABASE_COMMIT_OUTCOME_UNKNOWN",
        });
      }
    });

    try {
      const response = await POST(new Request(
        `https://asael.test/api/command/prompt-queue/${itemId}/dispatch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: 6, force: false }),
        },
      ), { params: Promise.resolve({ id: itemId }) });
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      await expect(reader!.read()).resolves.toMatchObject({ done: false });
      await expect(reader!.read()).resolves.toMatchObject({ done: false });
      await expect(reader!.read()).rejects.toThrow(
        "Prompt queue dispatch progress could not be persisted.",
      );
      expect(mocks.recordPromptQueueDispatchProgress).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
    }
  });
});

function sseResponse(events: readonly Record<string, unknown>[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  }), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}
