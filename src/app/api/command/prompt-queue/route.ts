import { promptQueueCreateRequestSchema } from "@/lib/command/prompt-queue-contracts";
import {
  createPromptQueueItem,
  listPromptQueueItems,
} from "@/lib/command/prompt-queue-store";
import { resolvePromptQueueContextPin } from "@/lib/command/prompt-queue-context";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { assistantModeRequiresUpgrade } from "@/lib/mobile/assistant-mode-compatibility";
import {
  promptQueueAuthority,
  promptQueueErrorResponse,
} from "@/app/api/command/prompt-queue/http";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "prompt_queue",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const items = await listPromptQueueItems(
    promptQueueAuthority(context, "prompt_queue.list"),
  );
  if (items.some(item => assistantModeRequiresUpgrade(item.mode,
    context.source === "mobile" ? context.native?.clientContractVersion || 0 : undefined))) {
    return Response.json({ error: "assistant_update_required",
      message: "Update Asael to use this queue's Chat, Cowork, and Coding prompts. Your queued work is saved and unchanged." },
    { status: 426, headers: { "cache-control": "private, no-store" } });
  }
  return Response.json({
    schemaVersion: 1,
    items,
    serverTime: new Date().toISOString(),
  });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = promptQueueCreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid prompt queue request",
      details: parsed.error.flatten(),
    }, { status: 400 });
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
    const authority = promptQueueAuthority(context, "prompt_queue.create");
    const contextPin = await resolvePromptQueueContextPin({
      context: { ...context, actorId: authority.ownerActorId },
      references: parsed.data.contextReferences || [],
      prompt: parsed.data.prompt,
      agentId: parsed.data.agentId,
      projectId: parsed.data.target.projectId,
    });
    const result = await createPromptQueueItem({
      request: parsed.data,
      authority,
      contextPin,
    });
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return promptQueueErrorResponse(error);
  }
}
