import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { listModelCatalog } from "@/lib/settings/store";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "model_catalog" });
  } catch (error) { return forbiddenResponse(error); }
  try {
    return Response.json({ models: await listModelCatalog(context) });
  } catch (error) { return settingsErrorResponse(error); }
}
