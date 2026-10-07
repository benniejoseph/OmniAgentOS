import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { csmErrorResponse, csmNoStoreHeaders } from "@/lib/csm/http";
import { saveCsmProfile, showCsmProject } from "@/lib/csm/service";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
type Route = { params: Promise<{ id: string }> };
export const GET = withDatabaseRequestScope(async (request: Request, route: Route) => {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "project", resourceId: id }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    const result = await showCsmProject(createAppServiceCaller({ context }), id);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: csmNoStoreHeaders });
  } catch (error) { return csmErrorResponse(error); }
});

export const PUT = withDatabaseRequestScope(requireIdempotencyKey(async (request: Request, route: Route) => {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "write.memory", resourceType: "shared_memory", resourceId: id }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request, 32_000); }
  catch (error) { return jsonBodyErrorResponse(error); }
  try {
    const result = await saveCsmProfile(createRequestMutationAppServiceCaller(request, context, { projectId: id, purpose: "api.csm.profile.write" }), id, body);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: csmNoStoreHeaders });
  } catch (error) { return csmErrorResponse(error); }
}));
