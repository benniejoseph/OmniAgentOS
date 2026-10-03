import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { ContentSearchRequestError, parseContentSearchRequest } from "@/lib/content-search/cursor";
import { searchContent } from "@/lib/content-search/service";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };
async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "content_search" }); }
  catch (error) { const response = forbiddenResponse(error); response.headers.set("cache-control", headers["cache-control"]); return response; }
  try {
    const query = parseContentSearchRequest(new URL(request.url), context);
    return Response.json(await searchContent(context, query), { headers });
  } catch (error) {
    if (error instanceof ContentSearchRequestError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
    return Response.json({ error: "Content search is temporarily unavailable.", code: "search_unavailable" }, { status: 503, headers });
  }
}
