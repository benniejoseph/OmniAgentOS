import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey, requiredRequestIdempotencyKey } from "@/lib/http/idempotency-key";
import { exactQuery, responsibilityDenial, responsibilityFailure, responsibilityHeaders } from "@/lib/responsibilities/http";
import { changeResponsibilityDraft, getResponsibilityDraft } from "@/lib/responsibilities/service";
import { ResponsibilityError } from "@/lib/responsibilities/state";
import { authorizeRequest } from "@/lib/security/guard";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(requireIdempotencyKey(PATCHHandler));
async function GETHandler(request: Request, route: RouteContext) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "responsibility_draft", resourceId: id }); }
  catch (error) { return responsibilityDenial(error); }
  try {
    const query = exactQuery(request, ["view"]);
    if (query.has("view") && query.get("view") !== "review") throw new ResponsibilityError("The responsibility view is unsupported.", 400, "responsibility_query_invalid");
    return Response.json(await getResponsibilityDraft(context, id, query.get("view") === "review"), { headers: responsibilityHeaders });
  } catch (error) { return responsibilityFailure(error); }
}
async function PATCHHandler(request: Request, route: RouteContext) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "responsibility_draft", resourceId: id, nativeMutationCapability: "responsibilities.drafts.manage" }); }
  catch (error) { return responsibilityDenial(error); }
  try {
    exactQuery(request, []);
    return Response.json(await changeResponsibilityDraft(context, id, await parseJsonBody(request, 32_768), requiredRequestIdempotencyKey(request)), { headers: responsibilityHeaders });
  } catch (error) { return responsibilityFailure(error); }
}
