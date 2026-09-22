import {
  promptQueueDeleteRequestSchema,
  promptQueueUpdateRequestSchema,
} from "@/lib/command/prompt-queue-contracts";
import {
  deletePromptQueueItem,
  updatePromptQueueItem,
} from "@/lib/command/prompt-queue-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  promptQueueAuthority,
  promptQueueErrorResponse,
} from "@/app/api/command/prompt-queue/http";

export const runtime = "nodejs";
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

type PromptQueueItemRouteContext = { params: Promise<{ id: string }> };

async function PATCHHandler(
  request: Request,
  context: PromptQueueItemRouteContext,
) {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = promptQueueUpdateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid prompt queue update", details: parsed.error.flatten() }, { status: 400 });
  }
  let security;
  try {
    security = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "prompt_queue",
      resourceId: id,
      nativeMutationCapability: "prompt.queue.manage",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const item = await updatePromptQueueItem({
      itemId: id,
      ...parsed.data,
      authority: promptQueueAuthority(security, "prompt_queue.update", id),
    });
    return Response.json({ item });
  } catch (error) {
    return promptQueueErrorResponse(error);
  }
}

async function DELETEHandler(
  request: Request,
  context: PromptQueueItemRouteContext,
) {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = promptQueueDeleteRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid prompt queue removal", details: parsed.error.flatten() }, { status: 400 });
  }
  let security;
  try {
    security = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "prompt_queue",
      resourceId: id,
      nativeMutationCapability: "prompt.queue.manage",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    await deletePromptQueueItem({
      itemId: id,
      expectedRevision: parsed.data.expectedRevision,
      authority: promptQueueAuthority(security, "prompt_queue.delete", id),
    });
    return Response.json({ deleted: true, id });
  } catch (error) {
    return promptQueueErrorResponse(error);
  }
}
