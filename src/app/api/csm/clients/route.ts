import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { csmErrorResponse, csmNoStoreHeaders } from "@/lib/csm/http";
import { listCsmClients } from "@/lib/csm/service";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request) => {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "project" }); }
  catch (error) { return forbiddenResponse(error); }
  try {
    const result = await listCsmClients(createAppServiceCaller({ context }));
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: csmNoStoreHeaders });
  } catch (error) { return csmErrorResponse(error); }
});
