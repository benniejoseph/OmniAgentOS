import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getOperationJobStats } from "@/lib/operations/job-queue";
import { processWorkflowQueue } from "@/lib/workflows/queue";
import { getWorkflowRunDetail } from "@/lib/workflows/store";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  try {
    await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow",
      resourceId: id,
    });
    const queue = await processWorkflowQueue({
      workflowRunId: id,
      limit: 1,
      bootstrapQueuedRuns: false,
    });
    return Response.json({
      detail: await getWorkflowRunDetail(id),
      queue,
      stats: await getOperationJobStats(),
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
