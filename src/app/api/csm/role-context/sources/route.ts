import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { csmErrorResponse, csmNoStoreHeaders } from "@/lib/csm/http";
import { linkCsmRoleSource, unlinkCsmRoleSource } from "@/lib/csm/role-service";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
async function mutate(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "write.memory", resourceType: "memory" }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request, 4_000); }
  catch (error) { return jsonBodyErrorResponse(error); }
  try {
    const caller = createRequestMutationAppServiceCaller(request, context, { purpose: "api.csm.role.sources.write" });
    const result = await (request.method === "DELETE" ? unlinkCsmRoleSource : linkCsmRoleSource)(caller, body);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: csmNoStoreHeaders });
  } catch (error) { return csmErrorResponse(error); }
}
export const POST = withDatabaseRequestScope(requireIdempotencyKey(mutate));
export const DELETE = withDatabaseRequestScope(requireIdempotencyKey(mutate));
