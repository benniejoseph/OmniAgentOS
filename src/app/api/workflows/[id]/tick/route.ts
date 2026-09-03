import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getOperationJobStats } from "@/lib/operations/job-queue";
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
    const queue = await processWorkflowQueue({
      workflowRunId: id,
      limit: 1,
      bootstrapQueuedRuns: false,
      tenantId: securityContext.tenantId,
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
    return Response.json(
      { error: error instanceof Error ? error.message : "Workflow tick failed." },
      { status: 404 },
    );
  }
}
