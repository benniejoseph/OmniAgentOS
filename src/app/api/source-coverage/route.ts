import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showSourceCoverageService } from "@/lib/app-services/source-coverage";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "source_coverage",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const workspaceId = new URL(request.url).searchParams.get("workspaceId")?.trim() || undefined;
    const result = await showSourceCoverageService(
      createAppServiceCaller({ context }),
      { workspaceId },
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    console.error(
      "Source coverage could not be loaded.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "Source coverage is temporarily unavailable." },
      { status: 503, headers: privateNoStoreHeaders },
    );
  }
}
