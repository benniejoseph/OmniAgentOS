import { ActivityRequestError, getActivity, parseActivityQuery } from "@/lib/activity/service";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "activity" });
  } catch (error) {
    const response = forbiddenResponse(error);
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
  try {
    const result = await getActivity({
      tenantId: context.tenantId,
      actorId: context.actorId,
      role: context.role,
      canReadApprovals: canPerform(context.role, "manage.workflow"),
      requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
    }, parseActivityQuery(new URL(request.url)));
    return Response.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ActivityRequestError) return Response.json({
      error: error.message,
      code: error.code,
      reload: true,
    }, { status: error.status, headers: { "cache-control": "private, no-store" } });
    return Response.json({ error: "Activity could not be loaded.", code: "activity_unavailable" }, {
      status: 503,
      headers: { "cache-control": "private, no-store" },
    });
  }
}
