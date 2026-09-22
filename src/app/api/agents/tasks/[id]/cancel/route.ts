import {
  agentTaskCancelServiceInputSchema,
  cancelAgentTaskService,
} from "@/lib/app-services/agents";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  DelegationExecutionConflictError,
  DelegationExecutionNotFoundError,
  DelegationExecutionUnavailableError,
} from "@/lib/delegation/execution-store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
const cancelBodySchema = agentTaskCancelServiceInputSchema.omit({ executionId: true });

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!idempotencyKey(request)) {
    return Response.json(
      { error: "An Idempotency-Key header is required." },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = cancelBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid delegation cancellation request.", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "delegation_execution",
      resourceId: id,
      metadata: {
        operation: "app.agents.tasks.cancel",
        signal: "cancel",
        expectedRevision: parsed.data.expectedRevision,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await cancelAgentTaskService(
      createRequestMutationAppServiceCaller(request, auth, {
        purpose: "delegation.execution.cancel",
        causationId: id,
      }),
      { executionId: id, ...parsed.data },
    );
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    if (error instanceof DelegationExecutionNotFoundError) {
      return Response.json(
        { error: "Delegated task not found." },
        { status: 404, headers: privateNoStoreHeaders },
      );
    }
    if (error instanceof DelegationExecutionConflictError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: 409, headers: privateNoStoreHeaders },
      );
    }
    if (error instanceof DelegationExecutionUnavailableError) {
      return Response.json(
        { error: "Delegated task control is temporarily unavailable." },
        { status: 503, headers: privateNoStoreHeaders },
      );
    }
    console.error(
      "Delegation cancellation failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "Delegated task cancellation failed." },
      { status: 500, headers: privateNoStoreHeaders },
    );
  }
}

function idempotencyKey(request: Request) {
  return request.headers.get("idempotency-key")?.trim() ||
    request.headers.get("x-idempotency-key")?.trim() ||
    request.headers.get("x-request-id")?.trim();
}
