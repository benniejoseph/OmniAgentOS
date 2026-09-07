import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showReadableMemoryService } from "@/lib/app-services/readable-memory";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseBoundedInteger } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory_overview",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const limit = parseBoundedInteger(
    new URL(request.url).searchParams.get("limit"),
    100,
    { max: 200 },
  );
  const result = await showReadableMemoryService(
    createAppServiceCaller({ context }),
    { limit },
  );
  return Response.json({
    ...result.data,
    serviceReceipt: result.receipt,
  }, { headers: privateNoStoreHeaders });
}
