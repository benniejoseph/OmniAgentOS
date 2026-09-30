import { appServiceTargetId, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { validateProviderService } from "@/lib/app-services/settings";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { SettingsStoreError } from "@/lib/settings/store";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));

async function POSTHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "provider_connection", resourceId: id, metadata: { operation: "validate_and_refresh_catalog" } });
  } catch (error) { return forbiddenResponse(error); }
  try {
    const connectionId = appServiceTargetId(id);
    if (!connectionId) throw new SettingsStoreError("Provider connection not found.", 404);
    const caller = createRequestMutationAppServiceCaller(request, context, { purpose: "settings.provider.validate", causationId: connectionId });
    const result = await validateProviderService(caller, { id: connectionId });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: { "cache-control": "no-store, private" } });
  } catch (error) { return settingsErrorResponse(error); }
}
