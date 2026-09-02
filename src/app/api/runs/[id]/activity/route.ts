import { withDatabaseRequestScope } from "@/lib/db/client";
import { listRunBrowserActivity } from "@/lib/runs/activity";
import { getAgentRun } from "@/lib/runs/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getThread } from "@/lib/threads/store";

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
      resourceType: "agent_run_activity",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const run = await getAgentRun(id, { tenantId: auth.tenantId });
  if (!run) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }
  if (run.threadId) {
    const thread = await getThread(run.threadId, { tenantId: auth.tenantId });
    if (!thread || thread.actorId !== auth.actorId) {
      return Response.json({ error: "Run not found." }, { status: 404 });
    }
  }

  return Response.json(
    {
      runId: run.id,
      status: run.status,
      browserActivity: await listRunBrowserActivity(run.id, {
        tenantId: auth.tenantId,
        actorId: auth.actorId,
      }),
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
