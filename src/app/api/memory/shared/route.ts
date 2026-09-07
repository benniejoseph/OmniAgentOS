import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  listSharedMemoryService,
  sharedMemoryListServiceInputSchema,
  sharedMemoryWriteServiceInputSchema,
  SharedContextWriteDeniedError,
  writeSharedMemoryService,
} from "@/lib/app-services/shared-memory";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { SharedContextAuthorityError } from "@/lib/memory/shared-context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "shared_memory",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const parsed = sharedMemoryListServiceInputSchema.safeParse({
    scope: url.searchParams.get("scope"),
    projectId: url.searchParams.get("projectId") || undefined,
    workspaceId: url.searchParams.get("workspaceId") || undefined,
    limit: numberOrDefault(url.searchParams.get("limit"), 50),
  });
  if (!parsed.success) return invalidSharedMemoryRequest();
  try {
    const result = await listSharedMemoryService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return sharedMemoryFailure(error, "read");
  }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = sharedMemoryWriteServiceInputSchema.safeParse(body);
  if (!parsed.success) return invalidSharedMemoryRequest();
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "shared_memory",
      metadata: {
        scope: parsed.data.scope,
        projectId: parsed.data.projectId,
        titleLength: parsed.data.title.length,
        contentLength: parsed.data.content.length,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await writeSharedMemoryService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.memory.shared.write",
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { status: 201, headers: privateNoStoreHeaders });
  } catch (error) {
    return sharedMemoryFailure(error, "write");
  }
}

function invalidSharedMemoryRequest() {
  return Response.json(
    { error: "Invalid shared-memory request." },
    { status: 400, headers: privateNoStoreHeaders },
  );
}

function sharedMemoryFailure(error: unknown, operation: "read" | "write") {
  if (error instanceof SharedContextAuthorityError) {
    const status = error.code === "scope_not_found" ? 404 : 503;
    return Response.json(
      { error: status === 404
        ? "The selected shared context was not found."
        : "Shared context is temporarily unavailable." },
      { status, headers: privateNoStoreHeaders },
    );
  }
  if (error instanceof SharedContextWriteDeniedError) {
    return Response.json(
      { error: "Shared context write access is required." },
      { status: 403, headers: privateNoStoreHeaders },
    );
  }
  console.error(
    `Shared memory ${operation} failed.`,
    error instanceof Error ? error.name : "UnknownError",
  );
  return Response.json(
    { error: `Shared memory ${operation} is temporarily unavailable.` },
    { status: 503, headers: privateNoStoreHeaders },
  );
}

function numberOrDefault(value: string | null, fallback: number) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
