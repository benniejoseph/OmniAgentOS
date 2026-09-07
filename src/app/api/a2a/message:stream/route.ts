import {
  a2aErrorResponse,
  a2aEventStreamResponse,
  a2aOptionsResponse,
  assertA2AJsonContentType,
  authorizeA2AHttpRequest,
  encodeA2AEvent,
  runInA2APrincipalScope,
} from "@/lib/a2a/http";
import { sendInboundA2AMessageV1 } from "@/lib/a2a/server";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withDatabaseRequestScope(POSTHandler);
export const OPTIONS = withDatabaseRequestScope(a2aOptionsResponse);

async function POSTHandler(request: Request) {
  let allowedOrigin: string | undefined;
  try {
    assertA2AJsonContentType(request);
    const authorization = await authorizeA2AHttpRequest(request, [
      "a2a:discover",
      "a2a:tasks:write",
    ]);
    allowedOrigin = authorization.allowedOrigin;
    const body = await parseJsonBody(request);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void runInA2APrincipalScope(authorization.principal, async () => {
          try {
            const task = await sendInboundA2AMessageV1({
              principal: authorization.principal,
              request: body,
              abortSignal: request.signal,
              onStatus: (update) => {
                controller.enqueue(encodeA2AEvent({
                  statusUpdate: {
                    taskId: update.taskId,
                    contextId: update.contextId,
                    status: {
                      state: update.state,
                      timestamp: new Date().toISOString(),
                    },
                  },
                }));
              },
            });
            controller.enqueue(encodeA2AEvent({ task }));
          } catch {
            controller.enqueue(encodeA2AEvent({
              message: {
                messageId: `a2a-stream-error:${Date.now()}`,
                role: "ROLE_AGENT",
                parts: [{ text: "The governed A2A task could not be completed." }],
              },
            }));
          } finally {
            controller.close();
          }
        });
      },
      cancel() {
        // Request cancellation is propagated through request.signal by the runtime.
      },
    });
    return a2aEventStreamResponse(stream, allowedOrigin);
  } catch (error) {
    return a2aErrorResponse(error, allowedOrigin);
  }
}
