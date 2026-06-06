import { listWorkflowPlanNodeExecutions, getWorkflowPlanNodeExecutionStats } from "@/lib/workflows/executor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 200);

  try {
    await authorizeRequest({
      request,
      action: "read",
      resourceType: "workflow_plan_execution",
      metadata: { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  return Response.json({
    executions: await listWorkflowPlanNodeExecutions(limit),
    stats: await getWorkflowPlanNodeExecutionStats(),
  });
}
