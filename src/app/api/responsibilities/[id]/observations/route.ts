import { withDatabaseRequestScope } from "@/lib/db/client";
import { exactQuery, responsibilityDenial, responsibilityFailure, responsibilityHeaders } from "@/lib/responsibilities/http";
import { getResponsibilityObservations } from "@/lib/responsibilities/observation-service";
import { ResponsibilityError } from "@/lib/responsibilities/state";
import { authorizeRequest } from "@/lib/security/guard";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };
export const GET = withDatabaseRequestScope(GETHandler);
async function GETHandler(request: Request, route: RouteContext) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "responsibility_observation", resourceId: id }); }
  catch (error) { return responsibilityDenial(error); }
  try {
    const query = exactQuery(request, ["limit"]);
    const raw = query.get("limit");
    if (raw !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw)) throw new ResponsibilityError("The observation limit must be 1–100.", 400, "responsibility_query_invalid");
    return Response.json(await getResponsibilityObservations(context, id, raw === null ? 25 : Number(raw)), { headers: responsibilityHeaders });
  } catch (error) { return responsibilityFailure(error); }
}
