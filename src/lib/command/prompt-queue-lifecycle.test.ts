import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspectReceipt: vi.fn(),
  recordProgress: vi.fn(),
  runWithActorScope: vi.fn(),
}));

vi.mock("@/lib/command/prompt-queue-store", () => ({
  inspectPromptQueueDispatchReceipt: mocks.inspectReceipt,
  recordPromptQueueDispatchProgress: mocks.recordProgress,
}));

vi.mock("@/lib/db/client", () => ({
  runWithDatabaseActorScope: (
    tenantId: string,
    actorIds: readonly string[],
    operation: () => unknown,
  ) => mocks.runWithActorScope(tenantId, actorIds, operation),
}));

import {
  createPromptQueueDispatchLifecycle,
  persistPromptQueueDispatchReceipt,
  PromptQueueDispatchReceiptStaleError,
  PromptQueueTerminalReceiptError,
  type PromptQueueDispatchReceiptBinding,
} from "@/lib/command/prompt-queue-lifecycle";
import type { AgentEvent } from "@/lib/orchestration/types";

const binding = {
  itemId: "11111111-1111-4111-8111-111111111111",
  dispatchToken: "private-dispatch-token",
  tenantId: "tenant-one",
  ownerActorId: "actor:canonical-owner",
  executionScope: {
    version: 1,
    tenantId: "tenant-one",
    initiatingActorId: "actor:canonical-owner",
    executingPrincipalType: "user",
    executingPrincipalId: "actor:canonical-owner",
    contextGrantIds: [],
    capabilityGrantIds: [],
    workspaceId: null,
    projectId: null,
    missionId: null,
    delegationId: null,
    correlationId: "prompt-queue:test",
    causationId: bindingItemId(),
    purpose: "prompt_queue.dispatch",
  },
} satisfies PromptQueueDispatchReceiptBinding;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspectReceipt.mockResolvedValue({ status: "stale" });
  mocks.recordProgress.mockResolvedValue({ status: "applied" });
  mocks.runWithActorScope.mockImplementation(async (
    _tenantId: string,
    _actorIds: readonly string[],
    operation: () => unknown,
  ) => operation());
});

describe("prompt queue in-band lifecycle", () => {
  it("withholds run and done until their receipts commit sequentially", async () => {
    const first = deferred<{ status: "applied" }>();
    const second = deferred<{ status: "applied" }>();
    mocks.recordProgress
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const lifecycle = createPromptQueueDispatchLifecycle(binding);
    const run: AgentEvent = {
      type: "run",
      runId: "run-one",
      threadId: "thread-one",
    };
    const done: AgentEvent = { type: "done", response: "complete" };

    let runSettled = false;
    const runProjection = lifecycle.beforeEmit(run).then((events) => {
      runSettled = true;
      return events;
    });
    await nextTurn();
    expect(runSettled).toBe(false);
    expect(mocks.recordProgress).toHaveBeenCalledOnce();
    first.resolve({ status: "applied" });
    await expect(runProjection).resolves.toEqual([run]);

    let doneSettled = false;
    const doneProjection = lifecycle.beforeEmit(done).then((events) => {
      doneSettled = true;
      return events;
    });
    await nextTurn();
    expect(doneSettled).toBe(false);
    expect(mocks.recordProgress).toHaveBeenCalledTimes(2);
    second.resolve({ status: "applied" });
    await expect(doneProjection).resolves.toEqual([done]);
    expect(mocks.recordProgress).toHaveBeenNthCalledWith(2, expect.objectContaining({
      runId: "run-one",
      threadId: "thread-one",
      terminal: "completed",
      progressLabel: "Governed run completed",
    }));
  });

  it("withholds all post-run events until a terminal receipt recovers the run link", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.recordProgress
      .mockRejectedValueOnce(new Error("run projection unavailable"))
      .mockResolvedValueOnce({ status: "applied" });
    const lifecycle = createPromptQueueDispatchLifecycle(binding);
    const run: AgentEvent = {
      type: "run",
      runId: "run-recovered",
      threadId: "thread-recovered",
    };
    const done: AgentEvent = { type: "done", response: "recovered" };

    try {
      await expect(lifecycle.beforeEmit(run)).resolves.toEqual([]);
      await expect(lifecycle.beforeEmit({
        type: "status",
        label: "Working",
      })).resolves.toEqual([]);
      await expect(lifecycle.beforeEmit({
        type: "delta",
        text: "private-unbound-delta",
      })).resolves.toEqual([]);
      await expect(lifecycle.beforeEmit({
        type: "tool",
        toolId: "tool-one",
        toolName: "example",
        status: "executed",
      })).resolves.toEqual([]);
      await expect(lifecycle.beforeEmit(done)).resolves.toEqual([run, done]);
      expect(mocks.recordProgress).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          runId: "run-recovered",
          threadId: "thread-recovered",
          terminal: "completed",
        }),
      );
      expect(logged).toHaveBeenCalledWith(
        "Prompt queue dispatch projection persistence failed.",
        expect.stringContaining('"phase":"run_link"'),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("fails closed on a done event before any governed run was accepted", async () => {
    const lifecycle = createPromptQueueDispatchLifecycle(binding);

    await expect(lifecycle.beforeEmit({
      type: "done",
      response: "unbound result",
    }, "thread-unbound")).resolves.toEqual([{
      type: "error",
      message:
        "The queued Agent stream ended before a governed run was accepted.",
    }]);
    expect(mocks.recordProgress).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-unbound",
      terminal: "failed",
      failureCode: "terminal_before_run_acceptance",
    }));
    await expect(lifecycle.beforeEmit({
      type: "delta",
      text: "post-terminal output",
    })).resolves.toEqual([]);
  });

  it("fails closed if one stream changes its governed run identity", async () => {
    const lifecycle = createPromptQueueDispatchLifecycle(binding);
    const firstRun: AgentEvent = {
      type: "run",
      runId: "run-first",
      threadId: "thread-first",
    };

    await expect(lifecycle.beforeEmit(firstRun)).resolves.toEqual([firstRun]);
    await expect(lifecycle.beforeEmit({
      type: "run",
      runId: "run-second",
      threadId: "thread-second",
    })).resolves.toEqual([{
      type: "error",
      message: "The queued Agent stream changed run identity and was stopped.",
    }]);
    expect(mocks.recordProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: "run-first",
        threadId: "thread-first",
        terminal: "failed",
        failureCode: "conflicting_run_identity",
      }),
    );
    await expect(lifecycle.beforeEmit({
      type: "done",
      response: "ambiguous terminal",
    })).resolves.toEqual([]);
  });

  it.each([
    [
      "clarification",
      {
        type: "clarification",
        threadId: "thread-c",
        message: "Which item?",
        reasonCode: "ambiguous_read_target",
      } satisfies AgentEvent,
      "completed",
      "Accepted and waiting for clarification",
      undefined,
    ],
    [
      "delegated",
      {
        type: "delegated",
        threadId: "thread-d",
        workflowId: "workflow-d",
        acknowledgement: "Delegated",
        reason: "Durable work",
      } satisfies AgentEvent,
      "completed",
      "Accepted as durable work",
      undefined,
    ],
    [
      "waiting approval",
      {
        type: "waiting_approval",
        executionId: "execution-w",
        toolId: "tool-w",
        message: "Approve",
      } satisfies AgentEvent,
      "completed",
      "Accepted and waiting for approval",
      undefined,
    ],
    [
      "error",
      { type: "error", message: "failed" } satisfies AgentEvent,
      "failed",
      "Governed run failed",
      "run_failed",
    ],
    [
      "typed canceled",
      { type: "canceled", message: "canceled" } satisfies AgentEvent,
      "failed",
      "Governed run canceled",
      "run_canceled",
    ],
    [
      "legacy canceled status",
      { type: "status", label: "Canceled" } satisfies AgentEvent,
      "failed",
      "Governed run canceled",
      "run_canceled",
    ],
  ])("persists %s as the chosen terminal outcome", async (
    _name,
    event,
    terminal,
    progressLabel,
    failureCode,
  ) => {
    const lifecycle = createPromptQueueDispatchLifecycle(binding);
    await expect(lifecycle.beforeEmit(event)).resolves.toEqual([event]);
    expect(mocks.recordProgress).toHaveBeenCalledWith(expect.objectContaining({
      terminal,
      progressLabel,
      ...(failureCode ? { failureCode } : {}),
    }));

    await expect(lifecycle.beforeEmit({
      type: terminal === "completed" ? "error" : "done",
      ...(terminal === "completed"
        ? { message: "later error" }
        : { response: "later success" }),
    } as AgentEvent)).resolves.toEqual([]);
    expect(mocks.recordProgress).toHaveBeenCalledOnce();
  });

  it("keeps EOF after a run nonterminal and releases a withheld run only after relinking it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.recordProgress
      .mockRejectedValueOnce(new Error("run projection unavailable"))
      .mockResolvedValueOnce({ status: "applied" });
    const lifecycle = createPromptQueueDispatchLifecycle(binding);
    const run: AgentEvent = { type: "run", runId: "run-eof" };

    try {
      await expect(lifecycle.beforeEmit(run, "thread-eof")).resolves.toEqual([]);
      await expect(lifecycle.finalizeEof("thread-eof")).resolves.toEqual([run]);
      await expect(lifecycle.finalizeEof("thread-eof")).resolves.toEqual([]);
      expect(mocks.recordProgress).toHaveBeenCalledTimes(2);
      expect(mocks.recordProgress).toHaveBeenLastCalledWith(expect.objectContaining({
        runId: "run-eof",
        threadId: "thread-eof",
        progressLabel: "Governed run accepted; reconciling terminal state",
      }));
      expect(mocks.recordProgress).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ terminal: expect.anything() }),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("does not infer completion when a durable run stream reaches EOF", async () => {
    const lifecycle = createPromptQueueDispatchLifecycle(binding);
    const run: AgentEvent = { type: "run", runId: "run-durable-eof" };

    await expect(lifecycle.beforeEmit(run, "thread-durable-eof"))
      .resolves.toEqual([run]);
    await expect(lifecycle.finalizeEof("thread-durable-eof"))
      .resolves.toEqual([]);
    await expect(lifecycle.finalizeEof("thread-durable-eof"))
      .resolves.toEqual([]);
    expect(mocks.recordProgress).toHaveBeenCalledOnce();
    expect(mocks.recordProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({ terminal: "completed" }),
    );
    expect(lifecycle.terminalWasChosen()).toBe(false);
  });

  it("records exactly one failed EOF fallback before a run", async () => {
    const lifecycle = createPromptQueueDispatchLifecycle(binding);

    await expect(lifecycle.finalizeEof("thread-before-run")).resolves.toEqual([]);
    await expect(lifecycle.finalizeEof("thread-before-run")).resolves.toEqual([]);
    expect(mocks.recordProgress).toHaveBeenCalledOnce();
    expect(mocks.recordProgress).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-before-run",
      terminal: "failed",
      failureCode: "stream_ended_before_acceptance",
    }));
  });

  it("turns terminal projection failure into a sanitized lifecycle error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.recordProgress.mockRejectedValue(new Error("secret database detail"));
    const lifecycle = createPromptQueueDispatchLifecycle(binding);

    try {
      await expect(lifecycle.beforeEmit({
        type: "done",
        response: "already durable agent response",
      })).rejects.toBeInstanceOf(PromptQueueTerminalReceiptError);
      expect(lifecycle.terminalWasChosen()).toBe(true);
      expect(lifecycle.terminalIsDurable()).toBe(false);
      await expect(lifecycle.finalizeEof()).resolves.toEqual([]);
      expect(mocks.recordProgress).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });
});

describe("prompt queue receipt persistence safety", () => {
  it("always uses the canonical owner actor scope", async () => {
    await persistPromptQueueDispatchReceipt(binding, {
      terminal: "failed",
      failureCode: "pre_stream_failure",
    });

    expect(mocks.runWithActorScope).toHaveBeenCalledWith(
      "tenant-one",
      ["actor:canonical-owner"],
      expect.any(Function),
    );
    expect(mocks.recordProgress).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-one",
      ownerActorId: "actor:canonical-owner",
      dispatchToken: "private-dispatch-token",
    }));
  });

  it("retries one exact pre-COMMIT connection close", async () => {
    mocks.recordProgress
      .mockRejectedValueOnce(Object.assign(new Error("closed"), {
        code: "DATABASE_CONNECTION_CLOSED",
      }))
      .mockResolvedValueOnce({ status: "applied" });

    await expect(persistPromptQueueDispatchReceipt(binding, {
      terminal: "completed",
    })).resolves.toEqual({ status: "applied" });
    expect(mocks.recordProgress).toHaveBeenCalledTimes(2);
  });

  it("accepts an unknown COMMIT outcome only when the exact receipt reads back", async () => {
    const unknown = Object.assign(new Error("unknown commit"), {
      code: "DATABASE_COMMIT_OUTCOME_UNKNOWN",
    });
    mocks.recordProgress.mockRejectedValueOnce(unknown);
    mocks.inspectReceipt.mockResolvedValueOnce({ status: "applied" });

    await expect(persistPromptQueueDispatchReceipt(binding, {
      terminal: "completed",
    })).resolves.toEqual({ status: "applied" });
    expect(mocks.recordProgress).toHaveBeenCalledOnce();
    expect(mocks.inspectReceipt).toHaveBeenCalledOnce();
  });

  it("retries an unknown COMMIT outcome once only after a compatible fence read", async () => {
    const unknown = Object.assign(new Error("unknown commit"), {
      code: "DATABASE_COMMIT_OUTCOME_UNKNOWN",
    });
    mocks.recordProgress
      .mockRejectedValueOnce(unknown)
      .mockResolvedValueOnce({ status: "applied" });
    mocks.inspectReceipt.mockResolvedValueOnce({ status: "retryable" });

    await expect(persistPromptQueueDispatchReceipt(binding, {
      runId: "run-safe-retry",
      threadId: "thread-safe-retry",
    })).resolves.toEqual({ status: "applied" });
    expect(mocks.recordProgress).toHaveBeenCalledTimes(2);
    expect(mocks.inspectReceipt).toHaveBeenCalledOnce();
  });

  it("never performs a second unknown-COMMIT replay without new certainty", async () => {
    const firstUnknown = Object.assign(new Error("first unknown commit"), {
      code: "DATABASE_COMMIT_OUTCOME_UNKNOWN",
    });
    const secondUnknown = Object.assign(new Error("second unknown commit"), {
      code: "DATABASE_COMMIT_OUTCOME_UNKNOWN",
    });
    mocks.recordProgress
      .mockRejectedValueOnce(firstUnknown)
      .mockRejectedValueOnce(secondUnknown);
    mocks.inspectReceipt.mockResolvedValue({ status: "retryable" });

    await expect(persistPromptQueueDispatchReceipt(binding, {
      terminal: "completed",
    })).rejects.toBe(secondUnknown);
    expect(mocks.recordProgress).toHaveBeenCalledTimes(2);
    expect(mocks.inspectReceipt).toHaveBeenCalledTimes(2);
  });

  it("treats a silent stale store result as non-durable", async () => {
    mocks.recordProgress.mockResolvedValueOnce({ status: "stale" });

    await expect(persistPromptQueueDispatchReceipt(binding, {
      terminal: "completed",
    })).rejects.toBeInstanceOf(PromptQueueDispatchReceiptStaleError);
    expect(mocks.recordProgress).toHaveBeenCalledOnce();
  });
});

function bindingItemId() {
  return "11111111-1111-4111-8111-111111111111";
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
