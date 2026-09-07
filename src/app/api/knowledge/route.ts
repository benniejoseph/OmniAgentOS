import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  deleteKnowledgeSourceService,
  knowledgeSourceDeleteServiceInputSchema,
  listKnowledgeService,
  searchKnowledgeService,
} from "@/lib/app-services/knowledge";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseBoundedInteger } from "@/lib/http/body";
import { knowledgeDeletionTargetId } from "@/lib/rag/deletion-events";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function DELETEHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "knowledge",
      metadata: { operation: "delete_source" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const parsed = knowledgeSourceDeleteServiceInputSchema.safeParse({
    source: new URL(request.url).searchParams.get("source")?.trim(),
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Choose a supported connected source." },
      { status: 400 },
    );
  }
  try {
    const result = await deleteKnowledgeSourceService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "knowledge.delete_source",
        causationId: knowledgeDeletionTargetId(parsed.data.source),
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Knowledge deletion failed.";
    return Response.json(
      { error: message },
      { status: /idempotency/i.test(message) ? 400 : 409 },
    );
  }
}

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "knowledge",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().slice(0, 4_000);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, {
    max: 100,
  });
  const caller = createAppServiceCaller({ context });
  const result = query
    ? await searchKnowledgeService(caller, { query, limit })
    : await listKnowledgeService(caller, { limit });
  return Response.json({
    ...result.data,
    serviceReceipt: result.receipt,
  }, { headers: privateNoStoreHeaders });
}
