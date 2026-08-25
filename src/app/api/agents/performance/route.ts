import { getAgentPerformance } from "@/lib/agents/performance";
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

  return Response.json(
    { agents: await getAgentPerformance(context.tenantId) },
    { headers: { "cache-control": "private, no-store" } },
  );
}
