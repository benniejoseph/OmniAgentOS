import { withDatabaseRequestScope } from "@/lib/db/client";
import { isServerFailure, serverErrorResponse } from "@/lib/http/errors";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getOperationJobStats } from "@/lib/operations/job-queue";
import { requestWorkDeadline } from "@/lib/observability/request-timing";
import { processWorkflowQueue } from "@/lib/workflows/queue";
import { publicWorkflowRunDetail } from "@/lib/workflows/public";
import { getWorkflowRunDetail } from "@/lib/workflows/store";

export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  try {
    const securityContext = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow",
      resourceId: id,
    });
    if (!await getWorkflowRunDetail(id, { tenantId: securityContext.tenantId, actorId: securityContext.actorId })) {
      return Response.json({ error: "Workflow run not found." }, { status: 404 });
    }
    // Stop the tick before the platform ends the request, so it goes back
    // to the queue instead of stranding on its lease.
    const deadlineAt = requestWorkDeadline(maxDuration);
    const queue = await processWorkflowQueue({
      workflowRunId: id,
      limit: 1,
      bootstrapQueuedRuns: false,
      tenantId: securityContext.tenantId,
      abortSignal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
      deadlineAt,
      keepQueuePlaceOnDeadline: true,
    });
    const detail = await getWorkflowRunDetail(id, {
      tenantId: securityContext.tenantId,
    });
    return Response.json({
      detail: detail ? publicWorkflowRunDetail(detail) : null,
      queue,
      stats: await getOperationJobStats({ tenantId: securityContext.tenantId }),
    });
  } catch (error) {
    try {
      return forbiddenResponse(error);
    } catch {
      // fall through to not-found style workflow error
    }
    if (isServerFailure(error)) {
      return serverErrorResponse(error, { message: "Workflow tick failed.", request });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Workflow tick failed." },
      { status: 404 },
    );
  }
}
