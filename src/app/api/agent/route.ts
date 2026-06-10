import { z } from "zod";
import { AGENT_MAX_MESSAGE_CHARS, AGENT_MAX_MESSAGES, AGENT_RUNS_PER_MINUTE } from "@/lib/config";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { checkRateLimit } from "@/lib/http/rate-limit";
import { encodeSse, sseResponse } from "@/lib/http/sse";
import { runAgent } from "@/lib/orchestration/agent-runner";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(AGENT_MAX_MESSAGE_CHARS),
});

const requestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(AGENT_MAX_MESSAGES),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
});

export async function POST(request: Request) {
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

  const rate = checkRateLimit({
    key: `agent:${context.tenantId}:${context.actorId}`,
    limit: AGENT_RUNS_PER_MINUTE,
  });
  if (!rate.allowed) {
    return Response.json(
      { error: "Rate limited", message: "Too many agent runs. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of runAgent(
          { ...parsed.data, tenantId: context.tenantId, actorId: context.actorId, role: context.role },
          request.signal,
        )) {
          controller.enqueue(encoder.encode(encodeSse(event)));
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            encodeSse({
              type: "error",
              message: error instanceof Error ? error.message : "Agent run failed.",
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
