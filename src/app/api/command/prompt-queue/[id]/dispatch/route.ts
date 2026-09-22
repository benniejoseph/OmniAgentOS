import {
  PROMPT_QUEUE_DISPATCH_ID_HEADER,
  PROMPT_QUEUE_DISPATCH_TOKEN_HEADER,
  promptQueueDispatchRequestSchema,
} from "@/lib/command/prompt-queue-contracts";
import {
  claimPromptQueueDispatch,
} from "@/lib/command/prompt-queue-store";
import {
  persistPromptQueueDispatchReceipt,
  type PromptQueueDispatchReceiptBinding,
} from "@/lib/command/prompt-queue-lifecycle";
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

type PromptQueueDispatchRouteContext = { params: Promise<{ id: string }> };

type PreparedPromptQueueDispatch = {
  internalRequest: Request;
  binding: PromptQueueDispatchReceiptBinding;
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
    await persistPromptQueueDispatchReceipt(binding, {
      terminal: "failed",
      progressLabel: "Governed execution could not start",
      failureCode: "agent_route_unavailable",
    });
    throw error;
  }
  if (!response.ok || !response.body) {
    await persistPromptQueueDispatchReceipt(binding, {
      terminal: "failed",
      progressLabel: "Governed execution was not accepted",
      failureCode: `agent_route_${response.status}`,
    });
    return response;
  }

  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("x-asael-prompt-queue-item", binding.itemId);
  responseHeaders.set("cache-control", "private, no-store");
  return new Response(response.body, {
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
