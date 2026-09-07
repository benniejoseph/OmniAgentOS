import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import {
  memoryLifecycleServiceInputSchema,
  updateMemoryLifecycleService,
} from "@/lib/app-services/memory";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const requestSchema = memoryLifecycleServiceInputSchema.omit({ id: true });
const privateNoStoreHeaders = { "cache-control": "private, no-store" };

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
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid memory lifecycle request",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "memory",
      resourceId: id,
      metadata: { lifecycleAction: parsed.data.action },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const result = await updateMemoryLifecycleService(
    createRequestMutationAppServiceCaller(request, context, {
      purpose: "api.memory.lifecycle.update",
      causationId: id,
    }),
    { id, action: parsed.data.action },
  );
  if (!result.data.lifecycle) {
    return Response.json({ error: "Memory not found." }, {
      status: 404,
      headers: privateNoStoreHeaders,
    });
  }
  return Response.json({
    ...result.data,
    serviceReceipt: result.receipt,
  }, { headers: privateNoStoreHeaders });
}
