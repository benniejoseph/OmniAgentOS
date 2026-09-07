import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { inspectRunTrajectoryService } from "@/lib/app-services/runs";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

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
      resourceType: "run_trajectory",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const result = await inspectRunTrajectoryService(createAppServiceCaller({ context: auth }), { runId: id });
    if (!result.data.trajectory) return Response.json({ error: "Run not found." }, { status: 404 });
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: { "cache-control": "private, no-store", "content-disposition": `attachment; filename="asael-trajectory-${id}.json"` } },
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Run not found.") throw error;
    return Response.json({ error: "Run not found." }, { status: 404 });
  }
}
