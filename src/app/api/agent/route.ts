import { z } from "zod";
import { AGENT_MAX_MESSAGE_CHARS, AGENT_MAX_MESSAGES, AGENT_RUNS_PER_MINUTE } from "@/lib/config";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import {
  checkSharedRateLimit,
  RateLimitStoreUnavailableError,
} from "@/lib/http/rate-limit";
import { encodeSse, sseResponse } from "@/lib/http/sse";
import { runAgent } from "@/lib/orchestration/agent-runner";
import { redactSensitive } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
// gpt-5 research/orchestrate runs can exceed 60s; 300s is the Vercel Pro ceiling.
// On Hobby this is silently capped to 60s (harmless).
export const maxDuration = 300;
export const POST = withDatabaseRequestScope(POSTHandler);

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(AGENT_MAX_MESSAGE_CHARS),
}).strict();

const requestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(AGENT_MAX_MESSAGES),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
}).strict();

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "agent_run",
      metadata: {
        mode: parsed.data.mode || "orchestrate",
        messageCount: parsed.data.messages.length,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  let rate;
  try {
    rate = await checkSharedRateLimit({
      key: `agent:${context.tenantId}:${context.actorId}`,
      limit: AGENT_RUNS_PER_MINUTE,
    });
  } catch (error) {
    if (!(error instanceof RateLimitStoreUnavailableError)) {
      throw error;
    }
    return Response.json(
      {
        error: "Agent temporarily unavailable",
        message: "The safety limiter is unavailable. Please try again shortly.",
      },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
  if (!rate.allowed) {
    return Response.json(
      { error: "Rate limited", message: "Too many agent runs. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  const encoder = new TextEncoder();
  const safeMessages = parsed.data.messages.map((message) => ({
    ...message,
    content: String(redactSensitive(message.content)),
  }));
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of runAgent(
          {
            ...parsed.data,
            messages: safeMessages,
            tenantId: context.tenantId,
            actorId: context.actorId,
            role: context.role,
          },
          request.signal,
        )) {
          controller.enqueue(encoder.encode(encodeSse(event)));
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            encodeSse({
              type: "error",
              message: String(
                redactSensitive(
                  error instanceof Error ? error.message : "Agent run failed.",
                ),
              ).slice(0, 1_000),
            }),
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return sseResponse(stream);
}
