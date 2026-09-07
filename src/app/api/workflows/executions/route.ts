import { withDatabaseRequestScope } from "@/lib/db/client";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { listWorkflowExecutionsService } from "@/lib/app-services/workflows";
import { parseBoundedInteger } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, {
    max: 200,
  });

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "workflow_plan_execution",
      metadata: { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const result = await listWorkflowExecutionsService(createAppServiceCaller({ context }), { limit });
  return Response.json({ ...result.data, serviceReceipt: result.receipt });
}
