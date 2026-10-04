import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showWorkspaceLibraryVersionService } from "@/lib/app-services/library-history";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { LibraryHistoryError, libraryHistoryItemIdSchema, libraryHistoryReadQuerySchema, libraryHistoryVersionIdSchema } from "@/lib/library/history-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };

async function GETHandler(request: Request, route: { params: Promise<{ id: string; versionId: string }> }) {
  const { id, versionId } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "workspace_library_item", resourceId: id }); }
  catch (error) { const response = forbiddenResponse(error); response.headers.set("cache-control", headers["cache-control"]); return response; }
  const parameters = new URL(request.url).searchParams;
  if ([...parameters.keys()].some((key) => key !== "currentVersionId" || parameters.getAll(key).length !== 1) ||
      !libraryHistoryItemIdSchema.safeParse(id).success || !libraryHistoryVersionIdSchema.safeParse(versionId).success) return invalid();
  const query = libraryHistoryReadQuerySchema.safeParse(parameters.has("currentVersionId") ? { currentVersionId: parameters.get("currentVersionId") } : {});
  if (!query.success) return invalid();
  try {
    const result = await showWorkspaceLibraryVersionService(createAppServiceCaller({ context }), { libraryItemId: id, versionId, query: query.data });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
  } catch (error) {
    if (error instanceof LibraryHistoryError) return Response.json({ error: error.message, code: error.code, ...(error.status === 409 ? { reload: true } : {}) }, { status: error.status, headers });
    return Response.json({ error: "Library version is temporarily unavailable.", code: "library_history_read_unavailable" }, { status: 503, headers });
  }
}
function invalid() { return Response.json({ error: "Invalid Library version query.", code: "invalid_library_history_query" }, { status: 400, headers }); }
