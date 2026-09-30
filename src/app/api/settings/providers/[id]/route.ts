import { z } from "zod";
import { appServiceTargetId, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { previewProviderRevokeService, revokeProviderService, updateProviderService } from "@/lib/app-services/settings";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { settingsErrorResponse } from "@/lib/settings/http";
import { SettingsStoreError } from "@/lib/settings/store";

export const runtime = "nodejs";
export const PATCH = withDatabaseRequestScope(requireIdempotencyKey(PATCHHandler));
export const DELETE = withDatabaseRequestScope(requireIdempotencyKey(DELETEHandler));

const updateSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "A change is required.");

async function PATCHHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid provider update", details: parsed.error.flatten() }, { status: 400 });
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "provider_connection", resourceId: id, metadata: { operation: "update", fields: Object.keys(parsed.data) } });
  } catch (error) { return forbiddenResponse(error); }
  try {
    const connectionId = providerConnectionId(id);
    const caller = createRequestMutationAppServiceCaller(request, context, { purpose: "settings.provider.update", causationId: connectionId });
    const result = await updateProviderService(caller, { id: connectionId, ...parsed.data });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: { "cache-control": "no-store, private" } });
  } catch (error) { return settingsErrorResponse(error); }
}

async function DELETEHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "provider_connection", resourceId: id, riskLevel: 2, metadata: { operation: "revoke_and_scrub" } });
  } catch (error) { return forbiddenResponse(error); }
  try {
    const connectionId = providerConnectionId(id);
    // The revocation is bound to the exact connection this request previews.
    const caller = createRequestMutationAppServiceCaller(request, context, { purpose: "settings.provider.revoke", causationId: connectionId });
    const preview = await previewProviderRevokeService(caller, { id: connectionId });
    if (!preview.data.target) throw new SettingsStoreError("Provider connection not found.", 404);
    const result = await revokeProviderService(caller, { id: connectionId, expectedTargetSha256: preview.data.targetSha256 });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: { "cache-control": "no-store, private" } });
  } catch (error) { return settingsErrorResponse(error); }
}

function providerConnectionId(id: string) {
  const connectionId = appServiceTargetId(id);
  if (!connectionId) throw new SettingsStoreError("Provider connection not found.", 404);
  return connectionId;
}
