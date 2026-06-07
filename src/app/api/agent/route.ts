import { z } from "zod";
import { encodeSse, sseResponse } from "@/lib/http/sse";
import { runAgent } from "@/lib/orchestration/agent-runner";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});

const requestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
});

export async function POST(request: Request) {
  const body = await request.json();
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
      action: "manage.workflow",
      resourceType: "agent_run",
      metadata: {
        mode: parsed.data.mode || "orchestrate",
        messageCount: parsed.data.messages.length,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of runAgent({ ...parsed.data, tenantId: context.tenantId }, request.signal)) {
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
