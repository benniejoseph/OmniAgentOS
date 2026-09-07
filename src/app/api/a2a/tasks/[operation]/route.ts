import {
  a2aErrorResponse,
  a2aEventStreamResponse,
  a2aJsonResponse,
  a2aOptionsResponse,
  authorizeA2AHttpRequest,
  encodeA2AEvent,
  runInA2APrincipalScope,
} from "@/lib/a2a/http";
import {
  cancelInboundA2ATaskV1,
  getInboundA2ATaskV1,
} from "@/lib/a2a/server";
import { A2AProtocolError } from "@/lib/a2a/v1-contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);
export const OPTIONS = withDatabaseRequestScope(a2aOptionsResponse);

type RouteContext = { params: Promise<{ operation: string }> };

async function GETHandler(request: Request, route: RouteContext) {
  let allowedOrigin: string | undefined;
  try {
    const authorization = await authorizeA2AHttpRequest(request, [
      "a2a:discover",
      "a2a:tasks:read",
    ]);
    allowedOrigin = authorization.allowedOrigin;
    const operation = decodeURIComponent((await route.params).operation);
    if (operation.endsWith(":cancel") || operation.endsWith(":subscribe")) {
      throw new A2AProtocolError("This A2A operation requires POST.", 400, "invalid_request");
    }
    const historyLengthValue = new URL(request.url).searchParams.get("historyLength");
    const historyLength = historyLengthValue === null ? undefined : Number(historyLengthValue);
    if (historyLength !== undefined && (!Number.isInteger(historyLength) || historyLength < 0 || historyLength > 50)) {
      throw new A2AProtocolError("A2A historyLength must be between 0 and 50.", 400, "invalid_params");
    }
    const task = await runInA2APrincipalScope(authorization.principal, () =>
      getInboundA2ATaskV1({
        principal: authorization.principal,
        taskId: operation,
        historyLength,
      })
    );
    return a2aJsonResponse({ task }, {}, allowedOrigin);
  } catch (error) {
    return a2aErrorResponse(error, allowedOrigin);
  }
}

async function POSTHandler(request: Request, route: RouteContext) {
  let allowedOrigin: string | undefined;
  try {
    const operation = decodeURIComponent((await route.params).operation);
    const subscribe = operation.endsWith(":subscribe");
    const cancel = operation.endsWith(":cancel");
    if (!subscribe && !cancel) {
      throw new A2AProtocolError("The A2A task operation is unsupported.", 400, "unsupported_operation");
    }
    const taskId = operation.slice(0, operation.lastIndexOf(":"));
    const authorization = await authorizeA2AHttpRequest(request, [
      "a2a:discover",
      subscribe ? "a2a:tasks:read" : "a2a:tasks:write",
    ]);
    allowedOrigin = authorization.allowedOrigin;
    if (cancel) {
      const task = await runInA2APrincipalScope(authorization.principal, () =>
        cancelInboundA2ATaskV1({ principal: authorization.principal, taskId })
      );
      return a2aJsonResponse({ task }, {}, allowedOrigin);
    }
    const task = await runInA2APrincipalScope(authorization.principal, () =>
      getInboundA2ATaskV1({ principal: authorization.principal, taskId })
    );
    if ([
      "TASK_STATE_COMPLETED",
      "TASK_STATE_FAILED",
      "TASK_STATE_CANCELED",
      "TASK_STATE_REJECTED",
    ].includes(task.status.state)) {
      throw new A2AProtocolError("A terminal A2A task cannot be subscribed.", 409, "unsupported_operation");
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodeA2AEvent({ task }));
        controller.close();
      },
    });
    return a2aEventStreamResponse(stream, allowedOrigin);
  } catch (error) {
    return a2aErrorResponse(error, allowedOrigin);
  }
}
