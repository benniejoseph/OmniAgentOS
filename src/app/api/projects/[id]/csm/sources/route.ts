import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { csmErrorResponse, csmNoStoreHeaders } from "@/lib/csm/http";
import { linkCsmSource, unlinkCsmSource } from "@/lib/csm/service";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
type Route = { params: Promise<{ id: string }> };
async function mutate(request: Request, route: Route) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "write.memory", resourceType: "shared_memory", resourceId: id }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request, 4_000); }
  catch (error) { return jsonBodyErrorResponse(error); }
  try {
    const caller = createRequestMutationAppServiceCaller(request, context, { projectId: id, purpose: "api.csm.sources.write" });
    const result = await (request.method === "DELETE" ? unlinkCsmSource : linkCsmSource)(caller, id, body);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: csmNoStoreHeaders });
  } catch (error) { return csmErrorResponse(error); }
}
export const POST = withDatabaseRequestScope(requireIdempotencyKey(mutate));
export const DELETE = withDatabaseRequestScope(requireIdempotencyKey(mutate));
