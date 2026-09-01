import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { revokeServiceApiKey } from "@/lib/settings/service-api-keys";

export const runtime = "nodejs";
export const DELETE = withDatabaseRequestScope(DELETEHandler);

async function DELETEHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "service_api_key", resourceId: id, riskLevel: 2, metadata: { operation: "revoke" } });
  } catch (error) { return forbiddenResponse(error); }
  try { return Response.json({ apiKey: await revokeServiceApiKey({ ...context, keyId: id }) }); }
  catch (error) { return settingsErrorResponse(error); }
}
