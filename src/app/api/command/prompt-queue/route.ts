import { promptQueueCreateRequestSchema } from "@/lib/command/prompt-queue-contracts";
import {
  createPromptQueueItem,
  listPromptQueueItems,
} from "@/lib/command/prompt-queue-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
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
    const result = await createPromptQueueItem({
      request: parsed.data,
      authority: promptQueueAuthority(context, "prompt_queue.create"),
    });
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return promptQueueErrorResponse(error);
  }
}
