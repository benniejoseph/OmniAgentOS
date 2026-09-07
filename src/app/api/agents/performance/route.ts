import { showAgentPerformanceService } from "@/lib/app-services/agents";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "agent_performance",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const result = await showAgentPerformanceService(createAppServiceCaller({ context }), {});
  return Response.json(
    { ...result.data, serviceReceipt: result.receipt },
    { headers: { "cache-control": "private, no-store" } },
  );
}
