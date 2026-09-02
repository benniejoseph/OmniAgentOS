import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { loadUsageSummary } from "@/lib/usage/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "usage_summary",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    return Response.json(
      { summary: await loadUsageSummary({ tenantId: context.tenantId }) },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    console.error(
      "Usage summary could not be loaded.",
      error instanceof Error ? error.message : error,
    );
    return Response.json(
      { error: "Usage summary is temporarily unavailable." },
      {
        status: 503,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
}
