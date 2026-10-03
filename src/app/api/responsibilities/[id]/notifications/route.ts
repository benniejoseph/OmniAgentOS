import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey, requiredRequestIdempotencyKey } from "@/lib/http/idempotency-key";
import { exactQuery, responsibilityDenial, responsibilityFailure, responsibilityHeaders } from "@/lib/responsibilities/http";
import { changeResponsibilityNotifications, getResponsibilityNotifications } from "@/lib/responsibilities/notification-service";
import { ResponsibilityError } from "@/lib/responsibilities/state";
import { authorizeRequest } from "@/lib/security/guard";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));
async function GETHandler(request: Request, route: RouteContext) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "responsibility_notifications", resourceId: id }); }
  catch (error) { return responsibilityDenial(error); }
  try {
    const query = exactQuery(request, ["view"]);
    if (query.has("view") && query.get("view") !== "enable") throw new ResponsibilityError("The responsibility notification view is unsupported.", 400, "responsibility_query_invalid");
    return Response.json(await getResponsibilityNotifications(context, id, query.get("view") === "enable"), { headers: responsibilityHeaders });
  } catch (error) { return responsibilityFailure(error); }
}
async function POSTHandler(request: Request, route: RouteContext) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "responsibility_notifications", resourceId: id, nativeMutationCapability: "responsibilities.notifications.manage" }); }
  catch (error) { return responsibilityDenial(error); }
  try {
    exactQuery(request, []);
    return Response.json(await changeResponsibilityNotifications(context, id, await parseJsonBody(request, 4096), requiredRequestIdempotencyKey(request)), { headers: responsibilityHeaders });
  } catch (error) { return responsibilityFailure(error); }
}
