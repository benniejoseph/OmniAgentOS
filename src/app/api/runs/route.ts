import { getRunStats, listAgentRuns, repairStuckAgentRuns } from "@/lib/runs/store";
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

  // Opportunistically repair runs stuck in 'running' from timed-out invocations.
  repairStuckAgentRuns().catch(() => {});

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") || 20);
  const includeStats = url.searchParams.get("stats") === "true";
  return Response.json({
    runs: await listAgentRuns(Math.min(Math.max(limit, 1), 100), { tenantId: context.tenantId }),
    ...(includeStats ? { stats: await getRunStats({ tenantId: context.tenantId }) } : {}),
  });
}
