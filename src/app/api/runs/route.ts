import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { listRunsService } from "@/lib/app-services/runs";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseBoundedInteger } from "@/lib/http/body";
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
  const result = await listRunsService(
    createAppServiceCaller({ context }),
    { limit, includeStats },
  );
  return Response.json({
    ...result.data,
    serviceReceipt: result.receipt,
  });
}
