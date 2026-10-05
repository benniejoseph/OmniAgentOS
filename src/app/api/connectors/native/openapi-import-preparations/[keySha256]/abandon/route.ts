import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { abandonNativeOpenapiImportPreparationService } from "@/lib/app-services/connector-openapi-import";
import { connectorNativeOpenapiImportPreparationAbandonRequestSchema } from "@/lib/connectors/native-openapi-import-contracts";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { nativeConnectorOpenapiImportReadInputSchema } from "@/lib/mobile/connector-openapi-import-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const POST = withDatabaseRequestScope(requireIdempotencyKey(async (request: Request, route: { params: Promise<{ keySha256: string }> }) => {
  const key = nativeConnectorOpenapiImportReadInputSchema.safeParse(await route.params);
  if (!key.success || [...new URL(request.url).searchParams].length) {
    return Response.json({ error: "An exact OpenAPI import preparation abandonment key is required." }, { status: 400, headers: nativeConnectorHeaders });
  }
  let body;
  try { body = await parseJsonBody(request, 16_384); }
  catch (error) { return privateConnectorResponse(jsonBodyErrorResponse(error)); }
  const parsed = connectorNativeOpenapiImportPreparationAbandonRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "The original safe OpenAPI import preparation intent is required." }, { status: 400, headers: nativeConnectorHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "connector_native_preparation", resourceId: parsed.data.intent.connectorId,
      nativeMutationCapability: "connectors.openapi.import", riskLevel: 0, metadata: { operation: "abandon_openapi_import_preparation", kind: "openapi" } });
  } catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try {
    const result = await abandonNativeOpenapiImportPreparationService(createRequestMutationAppServiceCaller(request, context, {
      purpose: "api.connectors.native.openapi_import_preparation.abandon", causationId: parsed.data.intent.connectorId,
    }), parsed.data, key.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: result.data.replayed ? 200 : 201, headers: nativeConnectorHeaders });
  } catch (error) { return nativeConnectorFailureResponse(error); }
}));
