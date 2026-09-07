import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  listMemoryService,
  memoryWriteServiceInputSchema,
  searchMemoryService,
  writeMemoryService,
} from "@/lib/app-services/memory";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().slice(0, 4_000);
  const requestedThreadId = url.searchParams.get("threadId");
  const threadId = requestedThreadId?.trim().slice(0, 200);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, {
    max: 100,
  });
  if (requestedThreadId !== null && !threadId) {
    return Response.json(
      { error: "A threadId is required." },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  const caller = createAppServiceCaller({ context });
  if (query) {
    const result = await searchMemoryService(caller, { query, limit });
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  }
  const result = await listMemoryService(caller, {
    limit,
    ...(threadId ? { threadId } : {}),
  });
  if ("threadFound" in result.data && !result.data.threadFound) {
    return Response.json(
      { error: "Thread not found." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
  return Response.json({
    memories: result.data.memories,
    serviceReceipt: result.receipt,
  }, { headers: privateNoStoreHeaders });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = memoryWriteServiceInputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid memory", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "memory",
      metadata: {
        titleLength: parsed.data.title.length,
        type: parsed.data.type,
        tagCount: parsed.data.tags?.length || 0,
        importance: parsed.data.importance,
        contentLength: parsed.data.content.length,
      },
    });
    const result = await writeMemoryService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.memory.write",
      }),
      parsed.data,
      { storageProfile: "user_private" },
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { status: 201, headers: privateNoStoreHeaders });
  } catch (error) {
    try {
      return forbiddenResponse(error);
    } catch {
      return Response.json({
        error: "Memory write failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }, { status: 500 });
    }
  }
}
