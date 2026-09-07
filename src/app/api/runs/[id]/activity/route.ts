import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { inspectRunActivityService } from "@/lib/app-services/runs";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

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

  try {
    const result = await inspectRunActivityService(createAppServiceCaller({ context: auth }), { runId: id });
    if (!result.data.status) {
      return Response.json(
        { error: "Run not found." },
        { status: 404, headers: privateNoStoreHeaders },
      );
    }
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Run not found.") throw error;
    return Response.json(
      { error: "Run not found." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
}
