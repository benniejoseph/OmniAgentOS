import { loadInboxCount } from "@/lib/approvals/inbox-count";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

/**
 * The inbox badge. It only counts, so it is authorized as a read and the
 * navigation can poll it; opening the inbox still requires the permission
 * to decide.
 */
async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "inbox",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const count = await loadInboxCount({
    tenantId: context.tenantId,
    role: context.role,
  });
  return Response.json(count, {
    headers: { "cache-control": "private, no-store" },
  });
}
