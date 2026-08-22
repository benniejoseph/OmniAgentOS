import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseBoundedInteger } from "@/lib/http/body";
import { getApprovalQueue } from "@/lib/operations/queue";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 25, {
    max: 100,
  });

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "approval_queue",
      metadata: { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  return Response.json(await getApprovalQueue(limit, { tenantId: context.tenantId }));
}
