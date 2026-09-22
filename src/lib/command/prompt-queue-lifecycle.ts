import "server-only";

import {
  inspectPromptQueueDispatchReceipt,
  recordPromptQueueDispatchProgress,
  type PromptQueueDispatchProgressResult,
} from "@/lib/command/prompt-queue-store";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import type { AgentEvent } from "@/lib/orchestration/types";
import { redactSensitive } from "@/lib/security/context";
import type { ExecutionScope } from "@/lib/security/execution-scope";

export type PromptQueueDispatchReceiptBinding = Readonly<{
  itemId: string;
  dispatchToken: string;
  tenantId: string;
  ownerActorId: string;
  executionScope: ExecutionScope;
}>;

type PromptQueueDispatchReceipt = Readonly<{
  runId?: string;
  threadId?: string;
  progressLabel?: string;
  terminal?: "completed" | "failed";
  failureCode?: string;
}>;

export class PromptQueueDispatchReceiptStaleError extends Error {
  constructor() {
    super("The prompt queue dispatch receipt is no longer current.");
    this.name = "PromptQueueDispatchReceiptStaleError";
  }
}

export class PromptQueueTerminalReceiptError extends Error {
  constructor() {
    super("The prompt queue terminal receipt could not be recorded.");
    this.name = "PromptQueueTerminalReceiptError";
  }
}

/**
 * Persist one queue receipt under the queue's canonical owner boundary.
 *
 * DATABASE_CONNECTION_CLOSED is emitted only for a transaction that did not
 * reach COMMIT, so one attempt on the replacement generation is safe. An
 * unknown COMMIT outcome is read back under the same actor fence. It is only
 * retried when that read proves the same token still owns a compatible,
 * dispatching row; the uncertain write is never replayed blindly.
 */
export async function persistPromptQueueDispatchReceipt(
  binding: PromptQueueDispatchReceiptBinding,
  receipt: PromptQueueDispatchReceipt,
): Promise<PromptQueueDispatchProgressResult> {
  let closedGenerationRetries = 0;
  let provenUnknownCommitRetries = 0;
  while (true) {
    try {
      const result = await runWithDatabaseActorScope(
        binding.tenantId,
        [binding.ownerActorId],
        () => recordPromptQueueDispatchProgress({
          ...binding,
          ...receipt,
        }),
      );
      if (result.status !== "applied") {
        throw new PromptQueueDispatchReceiptStaleError();
      }
      return result;
    } catch (error) {
      if (
        databaseFailureCode(error) === "DATABASE_CONNECTION_CLOSED" &&
        closedGenerationRetries === 0
      ) {
        closedGenerationRetries += 1;
        continue;
      }
      if (
        databaseFailureCode(error) === "DATABASE_COMMIT_OUTCOME_UNKNOWN"
      ) {
        const inspection = await inspectReceiptAfterUncertainWrite(
          binding,
          receipt,
          error,
        );
        if (inspection === "applied") return { status: "applied" };
        if (inspection === "retryable" && provenUnknownCommitRetries === 0) {
          provenUnknownCommitRetries += 1;
          continue;
        }
      } else if (error instanceof PromptQueueDispatchReceiptStaleError) {
        const inspection = await inspectReceiptAfterUncertainWrite(
          binding,
          receipt,
          error,
        );
        if (inspection === "applied") return { status: "applied" };
      }
      throw error;
    }
  }
}

/**
 * Keep prompt-queue projection writes in the Agent event loop. A run or
 * terminal event is returned to the SSE caller only after its corresponding
 * queue receipt commits. A failed run-link projection is withheld and logged,
 * while the governed generator continues; the later terminal receipt carries
 * the same run/thread coordinates and can recover the projection atomically.
 */
export function createPromptQueueDispatchLifecycle(
  binding: PromptQueueDispatchReceiptBinding,
) {
  let runId: string | undefined;
  let threadId: string | undefined;
  let withheldRun: Extract<AgentEvent, { type: "run" }> | undefined;
  let runLinkDurable = false;
  let terminalChosen = false;
  let terminalDurable = false;
  let eofFinalized = false;

  return {
    async beforeEmit(
      event: AgentEvent,
      currentThreadId?: string,
    ): Promise<AgentEvent[]> {
      if (terminalChosen) return [];

      if (event.type === "run") {
        if (runId) {
          const conflictingIdentity = runId !== event.runId || Boolean(
            event.threadId && threadId && event.threadId !== threadId,
          );
          if (!conflictingIdentity) return [];
          terminalChosen = true;
          try {
            await persistPromptQueueDispatchReceipt(binding, {
              runId,
              threadId,
              terminal: "failed",
              progressLabel: "The Agent stream changed run identity",
              failureCode: "conflicting_run_identity",
            });
            terminalDurable = true;
            return [{
              type: "error",
              message:
                "The queued Agent stream changed run identity and was stopped.",
            }];
          } catch (error) {
            logProjectionFailure(binding, "terminal", error);
            throw new PromptQueueTerminalReceiptError();
          }
        }
        runId = event.runId;
        threadId = event.threadId || currentThreadId || threadId;
        try {
          await persistPromptQueueDispatchReceipt(binding, {
            runId,
            threadId,
            progressLabel: "Governed run accepted",
          });
          runLinkDurable = true;
          return [event];
        } catch (error) {
          withheldRun = event;
          logProjectionFailure(binding, "run_link", error);
          return [];
        }
      }

      threadId = eventThreadId(event) || currentThreadId || threadId;

      if (!runId && requiresAcceptedRun(event)) {
        terminalChosen = true;
        try {
          await persistPromptQueueDispatchReceipt(binding, {
            threadId,
            terminal: "failed",
            progressLabel: "The Agent stream ended before run acceptance",
            failureCode: "terminal_before_run_acceptance",
          });
          terminalDurable = true;
          return [{
            type: "error",
            message:
              "The queued Agent stream ended before a governed run was accepted.",
          }];
        } catch (error) {
          logProjectionFailure(binding, "terminal", error);
          throw new PromptQueueTerminalReceiptError();
        }
      }

      const terminal = terminalReceiptForEvent(event);
      if (!terminal) return withheldRun ? [] : [event];
      terminalChosen = true;

      try {
        await persistPromptQueueDispatchReceipt(binding, {
          runId,
          threadId,
          ...terminal,
        });
        terminalDurable = true;
        const projected = withheldRun ? [withheldRun, event] : [event];
        withheldRun = undefined;
        runLinkDurable = Boolean(runId);
        return projected;
      } catch (error) {
        logProjectionFailure(binding, "terminal", error);
        throw new PromptQueueTerminalReceiptError();
      }
    },

    async finalizeEof(currentThreadId?: string): Promise<AgentEvent[]> {
      if (terminalChosen || eofFinalized) return [];
      eofFinalized = true;
      threadId = currentThreadId || threadId;
      if (runId) {
        if (runLinkDurable) return [];
        try {
          await persistPromptQueueDispatchReceipt(binding, {
            runId,
            threadId,
            progressLabel: "Governed run accepted; reconciling terminal state",
          });
          runLinkDurable = true;
          const projected = withheldRun ? [withheldRun] : [];
          withheldRun = undefined;
          return projected;
        } catch (error) {
          logProjectionFailure(binding, "run_link_fallback", error);
          throw new PromptQueueTerminalReceiptError();
        }
      }

      terminalChosen = true;
      try {
        await persistPromptQueueDispatchReceipt(binding, {
          threadId,
          terminal: "failed",
          progressLabel: "The governed run was not accepted",
          failureCode: "stream_ended_before_acceptance",
        });
        terminalDurable = true;
        return [];
      } catch (error) {
        logProjectionFailure(binding, "terminal_fallback", error);
        throw new PromptQueueTerminalReceiptError();
      }
    },

    terminalWasChosen() {
      return terminalChosen;
    },

    terminalIsDurable() {
      return terminalDurable;
    },
  };
}

export function promptQueueTerminalPersistenceErrorEvent(): AgentEvent {
  return {
    type: "error",
    message:
      "The queued result could not be linked to its queue item. Reconnect and review Results before retrying.",
  };
}

function terminalReceiptForEvent(
  event: AgentEvent,
): PromptQueueDispatchReceipt | undefined {
  switch (event.type) {
    case "done":
      return {
        terminal: "completed",
        progressLabel: "Governed run completed",
      };
    case "delegated":
      return {
        terminal: "completed",
        progressLabel: "Accepted as durable work",
      };
    case "clarification":
      return {
        terminal: "completed",
        progressLabel: "Accepted and waiting for clarification",
      };
    case "waiting_approval":
      return {
        terminal: "completed",
        progressLabel: "Accepted and waiting for approval",
      };
    case "error":
      return {
        terminal: "failed",
        progressLabel: "Governed run failed",
        failureCode: "run_failed",
      };
    case "canceled":
      return {
        terminal: "failed",
        progressLabel: "Governed run canceled",
        failureCode: "run_canceled",
      };
    case "status":
      return event.label === "Canceled"
        ? {
            terminal: "failed",
            progressLabel: "Governed run canceled",
            failureCode: "run_canceled",
          }
        : undefined;
    default:
      return undefined;
  }
}

function eventThreadId(event: AgentEvent) {
  return "threadId" in event && typeof event.threadId === "string"
    ? event.threadId
    : undefined;
}

function requiresAcceptedRun(event: AgentEvent) {
  return event.type === "done";
}

function databaseFailureCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

async function inspectReceiptAfterUncertainWrite(
  binding: PromptQueueDispatchReceiptBinding,
  receipt: PromptQueueDispatchReceipt,
  originalError: unknown,
) {
  try {
    const inspection = await runWithDatabaseActorScope(
      binding.tenantId,
      [binding.ownerActorId],
      () => inspectPromptQueueDispatchReceipt({
        itemId: binding.itemId,
        dispatchToken: binding.dispatchToken,
        tenantId: binding.tenantId,
        ownerActorId: binding.ownerActorId,
        ...receipt,
      }),
    );
    return inspection.status;
  } catch (inspectionError) {
    logProjectionFailure(binding, "receipt_inspection", inspectionError);
    throw originalError;
  }
}

function logProjectionFailure(
  binding: PromptQueueDispatchReceiptBinding,
  phase:
    | "run_link"
    | "run_link_fallback"
    | "terminal"
    | "terminal_fallback"
    | "receipt_inspection",
  error: unknown,
) {
  console.error(
    "Prompt queue dispatch projection persistence failed.",
    JSON.stringify({
      itemId: binding.itemId,
      phase,
      error: String(redactSensitive(
        error instanceof Error
          ? error.message
          : "Unknown prompt queue projection error.",
      )).slice(0, 1_000),
    }),
  );
}
