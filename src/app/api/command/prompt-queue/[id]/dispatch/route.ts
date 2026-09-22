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
import { getAppBaseUrl } from "@/lib/config";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
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
    response = await fetch(internalRequest, { redirect: "manual" });
  } catch (error) {
    await persistPromptQueueDispatchReceipt(binding, {
      terminal: "failed",
      progressLabel: "Governed execution could not start",
      failureCode: "agent_route_unavailable",
    });
    throw error;
  }
  if (!response.ok) {
    await persistPromptQueueDispatchReceipt(binding, {
      terminal: "failed",
      progressLabel: "Governed execution was not accepted",
      failureCode: `agent_route_${response.status}`,
    });
    if (response.status >= 300 && response.status < 400) {
      return forwardAgentResponse(Response.json({
        error: "Governed execution unavailable",
        message: "The governed Agent service returned an unexpected redirect.",
      }, { status: 502 }), binding.itemId);
    }
    return forwardAgentResponse(response, binding.itemId);
  }
  if (
    !response.body ||
    !response.headers.get("content-type")?.toLowerCase().startsWith(
      "text/event-stream",
    )
  ) {
    if (response.body) {
      await cancelUnexpectedAgentBody(response.body);
    }
    await persistPromptQueueDispatchReceipt(binding, {
      terminal: "failed",
      progressLabel: "Governed execution returned an invalid stream",
      failureCode: response.body
        ? "agent_route_invalid_content_type"
        : "agent_route_empty_stream",
    });
    return forwardAgentResponse(Response.json({
      error: "Governed execution unavailable",
      message: "The governed Agent service did not return a live event stream.",
    }, { status: 502 }), binding.itemId);
  }
  return forwardAgentResponse(response, binding.itemId);
}

async function cancelUnexpectedAgentBody(body: ReadableStream<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = body.cancel().catch(() => undefined);
  try {
    await Promise.race([
      cancellation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function forwardAgentResponse(response: Response, itemId: string) {
  const responseHeaders = new Headers(response.headers);
  for (const name of [
    "connection",
    "content-encoding",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    responseHeaders.delete(name);
  }
  responseHeaders.set("x-asael-prompt-queue-item", itemId);
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
  let agentUrl: URL;
  try {
    agentUrl = governedAgentUrl(request);
  } catch {
    return Response.json({
      error: "Invalid prompt queue dispatch origin",
      message: "The queued command must be dispatched through this Asael deployment.",
    }, {
      status: 400,
      headers: { "cache-control": "private, no-store" },
    });
  }
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
  headers.set("accept-encoding", "identity");
  headers.set(PROMPT_QUEUE_DISPATCH_ID_HEADER, item.id);
  headers.set(PROMPT_QUEUE_DISPATCH_TOKEN_HEADER, claimed.dispatchToken);
  for (const name of [
    "connection",
    "content-encoding",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-vercel-forwarded-for",
    "x-vercel-id",
  ]) {
    headers.delete(name);
  }
  const internalRequest = new Request(
    agentUrl,
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

function governedAgentUrl(request: Request) {
  const requestUrl = new URL(request.url);
  if (
    process.env.NODE_ENV === "production" &&
    !productionDispatchOrigins().has(requestUrl.origin)
  ) {
    throw new Error("Prompt queue dispatch received an untrusted request origin.");
  }
  return new URL(
    "/api/agent",
    process.env.NODE_ENV === "production"
      ? vercelOrigin(process.env.VERCEL_URL) || requestUrl.origin
      : requestUrl.origin,
  );
}

function productionDispatchOrigins() {
  const origins = new Set([new URL(getAppBaseUrl()).origin]);
  for (const value of [
    process.env.VERCEL_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ]) {
    const origin = vercelOrigin(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

function vercelOrigin(value: string | undefined) {
  const host = value?.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return host && /^[a-z0-9.-]+(?::\d+)?$/i.test(host)
    ? `https://${host}`
    : undefined;
}
