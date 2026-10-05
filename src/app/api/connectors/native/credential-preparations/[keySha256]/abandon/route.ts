import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { abandonNativeConnectorCredentialPreparationService } from "@/lib/app-services/connector-credential-rotation";
import { connectorNativeCredentialPreparationAbandonRequestSchema } from "@/lib/connectors/native-credential-rotation-contracts";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { nativeConnectorCredentialReadInputSchema } from "@/lib/mobile/connector-credential-rotation-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const POST = withDatabaseRequestScope(requireIdempotencyKey(async (request: Request, route: { params: Promise<{ keySha256: string }> }) => {
  const key = nativeConnectorCredentialReadInputSchema.safeParse(await route.params);
  if (!key.success || [...new URL(request.url).searchParams].length) {
    return Response.json({ error: "An exact credential preparation abandonment key is required." }, { status: 400, headers: nativeConnectorHeaders });
  }
  let body;
  try { body = await parseJsonBody(request, 16_384); }
  catch (error) { return privateConnectorResponse(jsonBodyErrorResponse(error)); }
  const parsed = connectorNativeCredentialPreparationAbandonRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "The original safe credential preparation intent is required." }, { status: 400, headers: nativeConnectorHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "connector_native_preparation", resourceId: parsed.data.intent.connectorId,
      nativeMutationCapability: "connectors.credentials.rotate", riskLevel: 2, metadata: { operation: "abandon_credential_preparation", kind: "mcp" } });
  } catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try {
    const result = await abandonNativeConnectorCredentialPreparationService(createRequestMutationAppServiceCaller(request, context, {
      purpose: "api.connectors.native.preparation.abandon", causationId: parsed.data.intent.connectorId,
    }), parsed.data, key.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: result.data.replayed ? 200 : 201, headers: nativeConnectorHeaders });
  } catch (error) { return nativeConnectorFailureResponse(error); }
}));
