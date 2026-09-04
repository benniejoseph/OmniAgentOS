import { withDatabaseRequestScope } from "@/lib/db/client";
import { listRunBrowserActivity } from "@/lib/runs/activity";
import { getAgentRun } from "@/lib/runs/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getOwnedThread } from "@/lib/threads/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

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
    return Response.json(
      { error: "Run not found." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
  if (run.threadId) {
    const thread = await getOwnedThread(run.threadId, {
      tenantId: auth.tenantId,
      actorId: auth.actorId,
      requestActorBinding: canonicalRequestActorBindingFromSecurityContext(auth),
    });
    if (!thread) {
      return Response.json(
        { error: "Run not found." },
        { status: 404, headers: privateNoStoreHeaders },
      );
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
    { headers: privateNoStoreHeaders },
  );
}
