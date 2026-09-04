import { withDatabaseRequestScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { listModelCatalogForRequest } from "@/lib/settings/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "model_catalog" });
  } catch (error) { return forbiddenResponse(error); }
  try {
    return Response.json({
      models: await listModelCatalogForRequest({
        tenantId: context.tenantId,
        actorId: context.actorId,
        requestActorBinding:
          canonicalRequestActorBindingFromSecurityContext(context),
      }),
    }, { headers: { "cache-control": "no-store, private" } });
  } catch (error) { return settingsErrorResponse(error); }
}
