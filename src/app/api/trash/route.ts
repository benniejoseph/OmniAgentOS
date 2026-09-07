import { listTrashService } from "@/lib/app-services/trash";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "read",
      resourceType: "trash_item",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || undefined;
  const limit = Number(url.searchParams.get("limit") || 50);
  try {
    const result = await listTrashService(
      createRequestMutationAppServiceCaller(request, auth, {
        purpose: "trash.list",
      }),
      { state, limit } as never,
    );
    return Response.json(
      { ...result.data, serviceReceipt: result.receipt },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Trash could not be listed." },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
}
