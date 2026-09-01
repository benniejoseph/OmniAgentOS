import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { validateAndRefreshProvider } from "@/lib/settings/provider-catalog";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "provider_connection", resourceId: id, metadata: { operation: "validate_and_refresh_catalog" } });
  } catch (error) { return forbiddenResponse(error); }
  try {
    return Response.json(await validateAndRefreshProvider({ ...context, connectionId: id }));
  } catch (error) { return settingsErrorResponse(error); }
}
