import { promptQueueReorderRequestSchema } from "@/lib/command/prompt-queue-contracts";
import { reorderPromptQueueItems } from "@/lib/command/prompt-queue-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  promptQueueAuthority,
  promptQueueErrorResponse,
} from "@/app/api/command/prompt-queue/http";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = promptQueueReorderRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid queue order", details: parsed.error.flatten() }, { status: 400 });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "prompt_queue",
      nativeMutationCapability: "prompt.queue.manage",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const items = await reorderPromptQueueItems({
      items: parsed.data.items,
      authority: promptQueueAuthority(context, "prompt_queue.reorder"),
    });
    return Response.json({ items });
  } catch (error) {
    return promptQueueErrorResponse(error);
  }
}
