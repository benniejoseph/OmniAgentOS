import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import {
  inspectMemoryLifecycleTargetService,
  memoryLifecycleServiceInputSchema,
  submitMemoryLifecycleMutationService,
  updateMemoryLifecycleService,
} from "@/lib/app-services/memory";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { MemoryLifecycleMutationError, memoryLifecycleMutationRequestSchema, memoryLifecycleTargetIdSchema } from "@/lib/memory/lifecycle-mutation-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const PATCH = withDatabaseRequestScope(requireIdempotencyKey(PATCHHandler));
export const GET = withDatabaseRequestScope(GETHandler);

const requestSchema = memoryLifecycleServiceInputSchema.omit({ id: true }).or(memoryLifecycleMutationRequestSchema);
const privateNoStoreHeaders = { "cache-control": "private, no-store" };

function mutationError(error: unknown) {
  return error instanceof MemoryLifecycleMutationError
    ? Response.json({ error: error.message, code: error.code }, { status: error.status, headers: privateNoStoreHeaders })
    : Response.json({ error: "Memory lifecycle is temporarily unavailable.", code: "memory_lifecycle_unavailable" }, { status: 503, headers: privateNoStoreHeaders });
}

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  if (!memoryLifecycleTargetIdSchema.safeParse(id).success || [...new URL(request.url).searchParams].length) {
    return Response.json({ error: "Invalid Memory lifecycle target." }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "memory", resourceId: id });
  } catch (error) { return forbiddenResponse(error); }
  try {
    const result = await inspectMemoryLifecycleTargetService(createAppServiceCaller({ context }), id);
    if (!result.data.current) return Response.json({ error: "Current private Memory was not found." }, { status: 404, headers: privateNoStoreHeaders });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
  } catch (error) { return mutationError(error); }
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
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid memory lifecycle request",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  if ("contract" in parsed.data && !memoryLifecycleTargetIdSchema.safeParse(id).success) {
    return Response.json({ error: "Invalid Memory lifecycle target." }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      nativeMutationCapability: "memory.lifecycle.write",
      resourceType: "memory",
      resourceId: id,
      metadata: { lifecycleAction: parsed.data.action },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  if (context.source === "mobile" && !("contract" in parsed.data)) {
    return Response.json({
      error: "Native Memory lifecycle changes require the reviewed revision contract.",
      code: "memory_lifecycle_contract_required",
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  const caller = createRequestMutationAppServiceCaller(request, context, {
      purpose: "api.memory.lifecycle.update",
      causationId: id,
    });
  if ("contract" in parsed.data) {
    try {
      const result = await submitMemoryLifecycleMutationService(caller, id, parsed.data);
      return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
    } catch (error) { return mutationError(error); }
  }
  const result = await updateMemoryLifecycleService(
    caller,
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
