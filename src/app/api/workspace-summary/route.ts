import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseBoundedInteger } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { loadWorkspaceSummary } from "@/lib/workspace/summary";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 16, {
    max: 50,
  });
  const approvalLimit = parseBoundedInteger(
    url.searchParams.get("approvalLimit"),
    12,
    { max: 25 },
  );

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "workspace_summary",
      metadata: { limit, approvalLimit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const summary = await loadWorkspaceSummary({
    tenantId: context.tenantId,
    role: context.role,
    limit,
    approvalLimit,
  });
  return Response.json(
    { summary },
    {
      headers: {
        "cache-control": "private, no-store",
      },
    },
  );
}
