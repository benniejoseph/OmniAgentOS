import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey, requiredRequestIdempotencyKey } from "@/lib/http/idempotency-key";
import { exactQuery, responsibilityDenial, responsibilityFailure, responsibilityHeaders } from "@/lib/responsibilities/http";
import { changeResponsibilityLifecycleService, getResponsibilityLifecycle } from "@/lib/responsibilities/lifecycle-service";
import { ResponsibilityError } from "@/lib/responsibilities/state";
import { authorizeRequest } from "@/lib/security/guard";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));
async function GETHandler(request: Request, route: RouteContext) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "responsibility_lifecycle", resourceId: id }); }
  catch (error) { return responsibilityDenial(error); }
  try {
    const query = exactQuery(request, ["view"]);
    if (query.has("view") && query.get("view") !== "activation") throw new ResponsibilityError("The responsibility view is unsupported.", 400, "responsibility_query_invalid");
    return Response.json(await getResponsibilityLifecycle(context, id, query.get("view") === "activation"), { headers: responsibilityHeaders });
  } catch (error) { return responsibilityFailure(error); }
}
async function POSTHandler(request: Request, route: RouteContext) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "responsibility_lifecycle", resourceId: id, nativeMutationCapability: "responsibilities.lifecycle.manage" }); }
  catch (error) { return responsibilityDenial(error); }
  try {
    exactQuery(request, []);
    return Response.json(await changeResponsibilityLifecycleService(context, id, await parseJsonBody(request, 4096), requiredRequestIdempotencyKey(request)), { headers: responsibilityHeaders });
  } catch (error) { return responsibilityFailure(error); }
}
