import { listAgentRuns } from "@/lib/runs/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

export async function GET(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "agent_run",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") || 20);
  return Response.json({
    runs: await listAgentRuns(Math.min(Math.max(limit, 1), 100), { tenantId: context.tenantId }),
  });
}
