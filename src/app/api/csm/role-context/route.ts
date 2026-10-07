import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { csmErrorResponse, csmNoStoreHeaders } from "@/lib/csm/http";
import { saveCsmRoleText, showCsmRoleContext } from "@/lib/csm/role-service";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request) => {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "memory" }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    const result = await showCsmRoleContext(createAppServiceCaller({ context }));
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: csmNoStoreHeaders });
  } catch (error) { return csmErrorResponse(error); }
});

export const PUT = withDatabaseRequestScope(requireIdempotencyKey(async (request: Request) => {
  let context;
  try { context = await authorizeRequest({ request, action: "write.memory", resourceType: "memory" }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request, 100_000); }
  catch (error) { return jsonBodyErrorResponse(error); }
  try {
    const result = await saveCsmRoleText(createRequestMutationAppServiceCaller(request, context, { purpose: "api.csm.role.write" }), body);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: csmNoStoreHeaders });
  } catch (error) { return csmErrorResponse(error); }
}));
