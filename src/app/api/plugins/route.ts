import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { listPluginsService } from "@/lib/app-services/plugins";
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
      resourceType: "plugin",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await listPluginsService(createAppServiceCaller({ context }), {});
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    console.error("Plugin catalog list failed.", error instanceof Error ? error.name : "UnknownError");
    return Response.json(
      { error: "Plugin catalog is temporarily unavailable." },
      { status: 503, headers: privateNoStoreHeaders },
    );
  }
}
