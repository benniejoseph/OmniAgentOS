import { showAgentDailyLearningStatusService } from "@/lib/app-services/agents";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { AgentIdentityResolutionError } from "@/lib/agents/identity-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(
  request: Request,
  context: RouteContext<"/api/agents/[id]/learning">,
) {
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "read",
      resourceType: "agent_learning",
      metadata: { operation: "show_daily_status" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const { id } = await context.params;
  if (!id.trim() || id.length > 200) {
    return Response.json(
      { error: "Invalid Agent learning target." },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  try {
    const result = await showAgentDailyLearningStatusService(
      createAppServiceCaller({ context: auth }),
      { agentId: id },
    );
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    if (error instanceof AgentIdentityResolutionError) {
      return Response.json(
        { error: "Exact Agent learning identity could not be verified." },
        { status: 409, headers: privateNoStoreHeaders },
      );
    }
    throw error;
  }
}
