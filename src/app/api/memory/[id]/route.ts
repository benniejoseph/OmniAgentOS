import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  correctMemoryService,
  forgetMemoryService,
  inspectMemoryService,
  memoryCorrectionServiceBodySchema,
  previewMemoryForgetService,
} from "@/lib/app-services/memory";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { MemoryDeletionPreviewConflictError } from "@/lib/memory/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const correctionSchema = memoryCorrectionServiceBodySchema;
const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function authorize(
  request: Request,
  id: string,
  action: "read" | "write.memory",
) {
  return authorizeRequest({
    request,
    action,
    resourceType: "memory",
    resourceId: id,
  });
}

async function GETHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  const deletionPreview = new URL(request.url).searchParams.get("view") ===
    "deletion-preview";
  let context;
  try {
    context = await authorize(
      request,
      id,
      deletionPreview ? "write.memory" : "read",
    );
  } catch (error) {
    return forbiddenResponse(error);
  }
  const caller = createAppServiceCaller({ context });
  if (deletionPreview) {
    const result = await previewMemoryForgetService(caller, { id });
    return result.data.preview
      ? Response.json({
          preview: result.data.preview,
          serviceReceipt: result.receipt,
        }, { headers: privateNoStoreHeaders })
      : Response.json({ error: "Memory not found." }, {
          status: 404,
          headers: privateNoStoreHeaders,
        });
  }
  const result = await inspectMemoryService(caller, { id });
  return result.data.memory
    ? Response.json({
        memory: result.data.memory,
        serviceReceipt: result.receipt,
      }, { headers: privateNoStoreHeaders })
    : Response.json({ error: "Memory not found." }, {
        status: 404,
        headers: privateNoStoreHeaders,
      });
}

async function PATCHHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = correctionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid correction",
      details: parsed.error.flatten(),
    }, { status: 400 });
  }
  let context;
  try {
    context = await authorize(request, id, "write.memory");
  } catch (error) {
    return forbiddenResponse(error);
  }
  const result = await correctMemoryService(
    createRequestMutationAppServiceCaller(request, context, {
      purpose: "api.memory.correct",
      causationId: id,
    }),
    { id, correction: parsed.data },
    { projectionSource: "manual" },
  );
  if (!result.data.correction) {
    return Response.json({ error: "Memory not found." }, { status: 404 });
  }
  return Response.json({
    ...result.data.correction,
    operationReceipt: result.data.operationReceipt,
    serviceReceipt: result.receipt,
  }, { headers: privateNoStoreHeaders });
}

async function DELETEHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorize(request, id, "write.memory");
  } catch (error) {
    return forbiddenResponse(error);
  }
  const expectedReceiptManifestSha256 = request.headers
    .get("x-asael-deletion-preview")?.trim();
  if (!expectedReceiptManifestSha256) {
    return Response.json({
      error: "Review the current deletion preview before forgetting this memory.",
    }, { status: 428, headers: privateNoStoreHeaders });
  }
  try {
    const result = await forgetMemoryService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.memory.forget",
        causationId: id,
      }),
      { id, expectedReceiptManifestSha256 },
    );
    if (!result.data.forgotten) {
      return Response.json({ error: "Memory not found." }, { status: 404 });
    }
    return Response.json({
      forgotten: true,
      ...result.data.forgotten,
      operationReceipt: result.data.operationReceipt,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    if (error instanceof MemoryDeletionPreviewConflictError) {
      return Response.json({ error: error.message }, {
        status: 409,
        headers: privateNoStoreHeaders,
      });
    }
    if (
      error instanceof Error &&
      error.message === "Memory deletion preview digest is invalid."
    ) {
      return Response.json({ error: error.message }, {
        status: 400,
        headers: privateNoStoreHeaders,
      });
    }
    throw error;
  }
}
