import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showTruthfulIntegrationsService } from "@/lib/app-services/integrations";
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
      resourceType: "integrations_overview",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspaceId")?.trim() || undefined;
    const result = await showTruthfulIntegrationsService(
      createAppServiceCaller({ context }),
      { workspaceId },
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    console.error(
      "Integrations overview could not be loaded.",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: "Integrations overview is temporarily unavailable." },
      { status: 503, headers: privateNoStoreHeaders },
    );
  }
}
