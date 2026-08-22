import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseBoundedInteger } from "@/lib/http/body";
import { publicAgentRun } from "@/lib/runs/public";
import { getRunStats, listAgentRuns } from "@/lib/runs/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
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
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, {
    max: 100,
  });
  const includeStats = url.searchParams.get("stats") === "true";
  const runs = (await listAgentRuns(limit, {
    tenantId: context.tenantId,
  })).map(publicAgentRun);
  const stats = includeStats
    ? await getRunStats({ tenantId: context.tenantId })
    : undefined;
  return Response.json({
    runs,
    ...(stats
      ? {
          stats: {
            ...stats,
            latest: stats.latest.map(publicAgentRun),
          },
        }
      : {}),
  });
}
