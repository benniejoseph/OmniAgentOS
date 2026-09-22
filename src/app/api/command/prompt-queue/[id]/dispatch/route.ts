import {
  PROMPT_QUEUE_DISPATCH_ID_HEADER,
  PROMPT_QUEUE_DISPATCH_TOKEN_HEADER,
  promptQueueDispatchRequestSchema,
} from "@/lib/command/prompt-queue-contracts";
import {
  claimPromptQueueDispatch,
  recordPromptQueueDispatchProgress,
} from "@/lib/command/prompt-queue-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { POST as runGovernedAgent } from "@/app/api/agent/route";
import {
  promptQueueAuthority,
  promptQueueErrorResponse,
} from "@/app/api/command/prompt-queue/http";

export const runtime = "nodejs";
export const maxDuration = 300;
export const POST = withDatabaseRequestScope(POSTHandler);

type PromptQueueDispatchRouteContext = { params: Promise<{ id: string }> };

async function POSTHandler(
  request: Request,
  route: PromptQueueDispatchRouteContext,
) {
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
  let response: Response;
  try {
    response = await runGovernedAgent(internalRequest);
  } catch (error) {
    await recordPromptQueueDispatchProgress({
      itemId: item.id,
      dispatchToken: claimed.dispatchToken,
      tenantId: context.tenantId,
      actorId: context.actorId,
      terminal: "failed",
      progressLabel: "Governed execution could not start",
      failureCode: "agent_route_unavailable",
      executionScope: authority.executionScope,
    });
    throw error;
  }
  if (!response.ok || !response.body) {
    await recordPromptQueueDispatchProgress({
      itemId: item.id,
      dispatchToken: claimed.dispatchToken,
      tenantId: context.tenantId,
      actorId: context.actorId,
      terminal: "failed",
      progressLabel: "Governed execution was not accepted",
      failureCode: `agent_route_${response.status}`,
      executionScope: authority.executionScope,
    });
    return response;
  }

  const observed = observeDispatchStream(response.body, {
    itemId: item.id,
    dispatchToken: claimed.dispatchToken,
    tenantId: context.tenantId,
    actorId: context.actorId,
    executionScope: authority.executionScope,
  });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("x-asael-prompt-queue-item", item.id);
  responseHeaders.set("cache-control", "private, no-store");
  return new Response(observed, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

function observeDispatchStream(
  source: ReadableStream<Uint8Array>,
  binding: {
    itemId: string;
    dispatchToken: string;
    tenantId: string;
    actorId: string;
    executionScope: ReturnType<typeof promptQueueAuthority>["executionScope"];
  },
) {
  const reader = source.getReader();
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
              await recordPromptQueueDispatchProgress({
                ...binding,
                runId,
                threadId,
                progressLabel: "Governed run accepted",
              });
            } else if (type === "done" || type === "delegated" ||
                type === "waiting_approval" || type === "clarification") {
              terminalObserved = true;
              if (typeof event.threadId === "string") threadId = event.threadId;
              await recordPromptQueueDispatchProgress({
                ...binding,
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
              await recordPromptQueueDispatchProgress({
                ...binding,
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
          await recordPromptQueueDispatchProgress({
            ...binding,
            runId,
            threadId,
            terminal: runId ? "completed" : "failed",
            progressLabel: runId
              ? "Governed run accepted; follow its activity"
              : "The governed run was not accepted",
            failureCode: runId ? undefined : "stream_ended_before_acceptance",
          });
        }
        controller.close();
      } catch (error) {
        if (!terminalObserved) {
          await recordPromptQueueDispatchProgress({
            ...binding,
            runId,
            threadId,
            terminal: runId ? "completed" : "failed",
            progressLabel: runId
              ? "Governed run accepted; live progress disconnected"
              : "The governed dispatch disconnected",
            failureCode: runId ? undefined : "dispatch_stream_disconnected",
          }).catch(() => undefined);
        }
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      if (!terminalObserved) {
        terminalObserved = true;
        await recordPromptQueueDispatchProgress({
          ...binding,
          runId,
          threadId,
          terminal: runId ? "completed" : "failed",
          progressLabel: runId
            ? "Governed run accepted; live progress disconnected"
            : "Dispatch disconnected before a governed run was accepted",
          failureCode: runId ? undefined : "dispatch_stream_disconnected",
        }).catch(() => undefined);
      }
      await reader.cancel(reason);
    },
  });
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
