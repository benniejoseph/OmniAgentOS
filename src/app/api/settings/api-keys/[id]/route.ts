import { appServiceTargetId, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { previewApiKeyRevokeService, revokeApiKeyService } from "@/lib/app-services/settings";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { ServiceApiKeyError } from "@/lib/settings/service-api-keys";

export const runtime = "nodejs";
export const DELETE = withDatabaseRequestScope(requireIdempotencyKey(DELETEHandler));

async function DELETEHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "service_api_key", resourceId: id, riskLevel: 2, metadata: { operation: "revoke" } });
  } catch (error) { return forbiddenResponse(error); }
  try {
    const keyId = appServiceTargetId(id);
    if (!keyId) throw new ServiceApiKeyError("API key not found.", 404);
    // The revocation is bound to the exact key this request previews.
    const caller = createRequestMutationAppServiceCaller(request, context, { purpose: "settings.api_key.revoke", causationId: keyId });
    const preview = await previewApiKeyRevokeService(caller, { id: keyId });
    if (!preview.data.target) throw new ServiceApiKeyError("API key not found.", 404);
    const result = await revokeApiKeyService(caller, { id: keyId, expectedTargetSha256: preview.data.targetSha256 });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: { "cache-control": "no-store, private" } });
  } catch (error) { return settingsErrorResponse(error); }
}
