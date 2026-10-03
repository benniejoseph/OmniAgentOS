import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { showWorkspaceLibraryItemService } from "@/lib/app-services/library";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };
async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "workspace_library", resourceId: id }); }
  catch (error) { const response = forbiddenResponse(error); response.headers.set("cache-control", headers["cache-control"]); return response; }
  // Keep the exact-open boundary at the same current source coverage as search.
  if (!/^library:(capture_asset|capture_recording|capture_transcript|project_artifact|source_item):.+$/.test(id) || id.length > 320) {
    return Response.json({ error: "This Library source is not supported by exact search opening." }, { status: 400, headers });
  }
  try {
    const result = await showWorkspaceLibraryItemService(createAppServiceCaller({ context }), { libraryItemId: id });
    return result.data.item ? Response.json({ item: result.data.item, serviceReceipt: result.receipt }, { headers }) :
      Response.json({ error: "This Library item is no longer available." }, { status: 404, headers });
  } catch { return Response.json({ error: "Library item could not be opened." }, { status: 503, headers }); }
}
