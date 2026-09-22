import { showAgentTaskService } from "@/lib/app-services/agents";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  DelegationExecutionConflictError,
  DelegationExecutionUnavailableError,
} from "@/lib/delegation/execution-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "read",
      resourceType: "delegation_execution",
      resourceId: id,
      metadata: { operation: "app.agents.tasks.show" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await showAgentTaskService(
      createAppServiceCaller({ context: auth }),
      { executionId: id },
    );
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    if (error instanceof DelegationExecutionConflictError) {
      return Response.json(
        { error: "Delegated task not found." },
        { status: 404, headers: privateNoStoreHeaders },
      );
    }
    if (error instanceof DelegationExecutionUnavailableError) {
      return Response.json(
        { error: "Delegated task detail is temporarily unavailable." },
        { status: 503, headers: privateNoStoreHeaders },
      );
    }
    console.error(
      "Delegated task detail failed.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "Delegated task detail failed." },
      { status: 500, headers: privateNoStoreHeaders },
    );
  }
}
