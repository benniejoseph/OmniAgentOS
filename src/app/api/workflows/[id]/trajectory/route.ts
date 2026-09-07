import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showWorkflowTrajectoryService } from "@/lib/app-services/workflow-inspection";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

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
      resourceType: "workflow_trajectory",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const result = await showWorkflowTrajectoryService(createAppServiceCaller({ context: auth }), { workflowId: id });
    if (!result.data.traceHierarchy) return Response.json({ error: "Workflow run not found." }, { status: 404 });

    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": `attachment; filename="asael-workflow-trace-${id}.json"`,
        },
      },
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Workflow run not found.") throw error;
    return Response.json({ error: "Workflow run not found." }, { status: 404 });
  }
}
