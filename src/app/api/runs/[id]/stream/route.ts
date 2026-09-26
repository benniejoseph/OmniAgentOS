import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showRunServiceWithRecord } from "@/lib/app-services/runs";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { agentRunTailResponse, parseRunEventCursor } from "@/lib/runs/event-tail";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 300;
export const GET = withDatabaseRequestScope(GETHandler);

/**
 * Resumes a run's event stream after a dropped connection. Send the id of
 * the last event received as `Last-Event-ID` (or `?after=`); the stream
 * replays every later persisted step, then ends with the run's outcome, or
 * ends early while the run is still working so the client reconnects.
 */
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
      resourceType: "agent_run",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  let run;
  try {
    ({ run } = await showRunServiceWithRecord(
      createAppServiceCaller({ context: auth }),
      { runId: id },
    ));
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Run not found.") throw error;
    return Response.json({ error: "Run not found." }, { status: 404 });
  }
  if (!run) return Response.json({ error: "Run not found." }, { status: 404 });

  return agentRunTailResponse({
    runId: run.id,
    tenantId: auth.tenantId,
    threadId: run.threadId,
    afterSeq: parseRunEventCursor(request),
    signal: request.signal,
    headers: { "X-Asael-Run-Id": run.id },
  });
}
