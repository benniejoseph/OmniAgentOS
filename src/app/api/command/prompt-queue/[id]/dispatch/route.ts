import {
  PROMPT_QUEUE_DISPATCH_ID_HEADER,
  PROMPT_QUEUE_DISPATCH_TOKEN_HEADER,
  promptQueueDispatchRequestSchema,
} from "@/lib/command/prompt-queue-contracts";
import {
  claimPromptQueueDispatch,
  recordPromptQueueDispatchProgress,
} from "@/lib/command/prompt-queue-store";
import {
  runWithDatabaseActorScope,
  withDatabaseRequestScope,
} from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { redactSensitive } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { POST as runGovernedAgent } from "@/app/api/agent/route";
import {
  promptQueueAuthority,
  promptQueueErrorResponse,
} from "@/app/api/command/prompt-queue/http";

export const runtime = "nodejs";
export const maxDuration = 300;

type PromptQueueDispatchRouteContext = { params: Promise<{ id: string }> };

type DispatchProgressBinding = {
  itemId: string;
  dispatchToken: string;
  tenantId: string;
  ownerActorId: string;
  executionScope: ReturnType<typeof promptQueueAuthority>["executionScope"];
};

type PreparedPromptQueueDispatch = {
  internalRequest: Request;
  binding: DispatchProgressBinding;
};

// Keep only admission in the request database scope. A ReadableStream created
// inside that AsyncLocalStorage boundary inherits it after the handler returns;
// the long-lived Agent SSE and its progress writes must start after it exits.
const preparePromptQueueDispatch = withDatabaseRequestScope(
  preparePromptQueueDispatchHandler,
);

export async function POST(
  request: Request,
  route: PromptQueueDispatchRouteContext,
) {
  const prepared = await preparePromptQueueDispatch(request, route);
  if (prepared instanceof Response) return prepared;

  const { binding, internalRequest } = prepared;
  let response: Response;
  try {
    response = await runGovernedAgent(internalRequest);
  } catch (error) {
    await persistDispatchProgress(binding, {
      terminal: "failed",
      progressLabel: "Governed execution could not start",
      failureCode: "agent_route_unavailable",
    });
    throw error;
  }
  if (!response.ok || !response.body) {
    await persistDispatchProgress(binding, {
      terminal: "failed",
      progressLabel: "Governed execution was not accepted",
      failureCode: `agent_route_${response.status}`,
    });
    return response;
  }

  const observed = observeDispatchStream(response.body, binding);
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("x-asael-prompt-queue-item", binding.itemId);
  responseHeaders.set("cache-control", "private, no-store");
  return new Response(observed, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

async function preparePromptQueueDispatchHandler(
  request: Request,
  route: PromptQueueDispatchRouteContext,
): Promise<PreparedPromptQueueDispatch | Response> {
  const { id } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = promptQueueDispatchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid prompt queue dispatch",
      details: parsed.error.flatten(),
    }, { status: 400 });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "prompt_queue",
      resourceId: id,
      nativeMutationCapability: "prompt.queue.manage",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const authority = promptQueueAuthority(
    context,
    "prompt_queue.dispatch",
    id,
  );
  let claimed;
  try {
    claimed = await claimPromptQueueDispatch({
      itemId: id,
      expectedRevision: parsed.data.expectedRevision,
      force: parsed.data.force,
      authority,
    });
  } catch (error) {
    return promptQueueErrorResponse(error);
  }

  const item = claimed.item;
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  headers.set(PROMPT_QUEUE_DISPATCH_ID_HEADER, item.id);
  headers.set(PROMPT_QUEUE_DISPATCH_TOKEN_HEADER, claimed.dispatchToken);
  headers.delete("content-length");
  const internalRequest = new Request(
    new URL("/api/agent", request.url),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: item.prompt,
        mode: item.mode,
        strategy: item.strategy,
        agentId: item.agent.logicalAgentId,
        threadId: item.target.threadId || undefined,
        missionId: item.target.missionId || undefined,
        projectId: item.target.projectId || undefined,
        computerUseTarget:
          item.target.executionTarget === "local_macos"
            ? "local_macos"
            : undefined,
        requestId: `prompt-queue-${item.id}-${item.lifecycleRevision}`,
      }),
      signal: request.signal,
    },
  );
  return {
    internalRequest,
    binding: {
      itemId: item.id,
      dispatchToken: claimed.dispatchToken,
      tenantId: context.tenantId,
      ownerActorId: authority.ownerActorId,
      executionScope: authority.executionScope,
    },
  };
}

function observeDispatchStream(
  source: ReadableStream<Uint8Array>,
  binding: DispatchProgressBinding,
) {
  const reader = source.getReader();
  const progressWriter = createDispatchProgressWriter(binding);
  const decoder = new TextDecoder();
  let buffer = "";
  let runId: string | undefined;
  let threadId: string | undefined;
  let terminalObserved = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || "";
          for (const block of blocks) {
            const event = parseSsePayload(block);
            if (!event) continue;
            const type = typeof event.type === "string" ? event.type : "";
            if (type === "run" && typeof event.runId === "string") {
              runId = event.runId;
              if (typeof event.threadId === "string") threadId = event.threadId;
              progressWriter.enqueue({
                runId,
                threadId,
                progressLabel: "Governed run accepted",
              });
            } else if (type === "done" || type === "delegated" ||
                type === "waiting_approval" || type === "clarification") {
              terminalObserved = true;
              if (typeof event.threadId === "string") threadId = event.threadId;
              progressWriter.enqueue({
                runId,
                threadId,
                terminal: "completed",
                progressLabel: type === "waiting_approval"
                  ? "Accepted and waiting for approval"
                  : type === "clarification"
                    ? "Accepted and waiting for clarification"
                    : type === "delegated"
                      ? "Accepted as durable work"
                      : "Governed run completed",
              });
            } else if (type === "error" || type === "canceled") {
              terminalObserved = true;
              progressWriter.enqueue({
                runId,
                threadId,
                terminal: "failed",
                progressLabel: type === "canceled"
                  ? "Governed run canceled"
                  : "Governed run failed",
                failureCode: type === "canceled" ? "run_canceled" : "run_failed",
              });
            }
          }
        }
        if (!terminalObserved) {
          progressWriter.enqueue({
            runId,
            threadId,
            terminal: runId ? "completed" : "failed",
            progressLabel: runId
              ? "Governed run accepted; follow its activity"
              : "The governed run was not accepted",
            failureCode: runId ? undefined : "stream_ended_before_acceptance",
          });
        }
        await progressWriter.flush();
        controller.close();
      } catch (error) {
        let streamError = error;
        try {
          await progressWriter.flush();
        } catch (progressError) {
          streamError = progressError;
        }
        if (!terminalObserved) {
          await persistDispatchProgress(binding, {
            runId,
            threadId,
            terminal: runId ? "completed" : "failed",
            progressLabel: runId
              ? "Governed run accepted; live progress disconnected"
              : "The governed dispatch disconnected",
            failureCode: runId ? undefined : "dispatch_stream_disconnected",
          }).catch((progressError: unknown) => {
            logDispatchProgressFailure(binding, progressError);
          });
        }
        controller.error(streamError);
      } finally {
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      if (!terminalObserved) {
        terminalObserved = true;
        progressWriter.enqueue({
          runId,
          threadId,
          terminal: runId ? "completed" : "failed",
          progressLabel: runId
            ? "Governed run accepted; live progress disconnected"
            : "Dispatch disconnected before a governed run was accepted",
          failureCode: runId ? undefined : "dispatch_stream_disconnected",
        });
      }
      let cancelError: unknown;
      try {
        await reader.cancel(reason);
      } catch (error) {
        cancelError = error;
      }
      try {
        await progressWriter.flush();
      } catch (error) {
        cancelError ??= error;
      }
      if (cancelError !== undefined) throw cancelError;
    },
  });
}

type DispatchProgressUpdate = Omit<
  Parameters<typeof recordPromptQueueDispatchProgress>[0],
  keyof DispatchProgressBinding
>;

function createDispatchProgressWriter(binding: DispatchProgressBinding) {
  let writeChain: Promise<void> = Promise.resolve();
  let terminalReceiptEnqueued = false;
  let terminalReceiptPersisted = false;

  return {
    enqueue(progress: DispatchProgressUpdate) {
      const isTerminalReceipt = progress.terminal !== undefined;
      if (isTerminalReceipt) terminalReceiptEnqueued = true;
      writeChain = writeChain
        .then(() => persistDispatchProgress(binding, progress))
        .then(() => {
          if (isTerminalReceipt) terminalReceiptPersisted = true;
        })
        .catch((error: unknown) => {
          if (isTerminalReceipt) terminalReceiptPersisted = false;
          logDispatchProgressFailure(binding, error);
        });
    },
    async flush() {
      // Cancellation can enqueue its terminal receipt while the source-side
      // flush is already waiting. Continue until the observed tail is stable.
      while (true) {
        const pending = writeChain;
        await pending;
        if (pending === writeChain) break;
      }
      if (terminalReceiptEnqueued && !terminalReceiptPersisted) {
        throw new Error(
          "Prompt queue dispatch progress could not be persisted.",
        );
      }
    },
  };
}

async function persistDispatchProgress(
  binding: DispatchProgressBinding,
  progress: DispatchProgressUpdate,
) {
  let closedGenerationRetries = 0;
  while (true) {
    try {
      await runWithDatabaseActorScope(
        binding.tenantId,
        [binding.ownerActorId],
        () => recordPromptQueueDispatchProgress({ ...binding, ...progress }),
      );
      return;
    } catch (error) {
      if (
        databaseFailureCode(error) === "DATABASE_CONNECTION_CLOSED" &&
        closedGenerationRetries === 0
      ) {
        // The database client emits this exact code only before COMMIT, so the
        // dead transaction had no durable effect. Retry once on the replacement
        // pool generation; unknown COMMIT outcomes are never replayed.
        closedGenerationRetries += 1;
        continue;
      }
      throw error;
    }
  }
}

function databaseFailureCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function logDispatchProgressFailure(
  binding: DispatchProgressBinding,
  error: unknown,
) {
  console.error(
    "Prompt queue dispatch progress persistence failed.",
    JSON.stringify({
      itemId: binding.itemId,
      error: String(redactSensitive(
        error instanceof Error
          ? error.message
          : "Unknown prompt queue progress persistence error.",
      )).slice(0, 1_000),
    }),
  );
}

function parseSsePayload(block: string): Record<string, unknown> | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
