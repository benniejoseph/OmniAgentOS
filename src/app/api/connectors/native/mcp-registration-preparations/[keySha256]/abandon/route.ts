import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { abandonNativeMcpRegistrationPreparationService } from "@/lib/app-services/connector-mcp-registration";
import { connectorNativeMcpRegistrationPreparationAbandonRequestSchema } from "@/lib/connectors/native-mcp-registration-contracts";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { nativeConnectorMcpRegistrationReadInputSchema } from "@/lib/mobile/connector-mcp-registration-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const POST = withDatabaseRequestScope(requireIdempotencyKey(async (request: Request, route: { params: Promise<{ keySha256: string }> }) => {
  const key = nativeConnectorMcpRegistrationReadInputSchema.safeParse(await route.params);
  if (!key.success || [...new URL(request.url).searchParams].length) {
    return Response.json({ error: "An exact MCP registration preparation abandonment key is required." }, { status: 400, headers: nativeConnectorHeaders });
  }
  let body;
  try { body = await parseJsonBody(request, 16_384); }
  catch (error) { return privateConnectorResponse(jsonBodyErrorResponse(error)); }
  const parsed = connectorNativeMcpRegistrationPreparationAbandonRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "The original safe MCP registration preparation intent is required." }, { status: 400, headers: nativeConnectorHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "connector_native_preparation", resourceId: parsed.data.intent.connectorId,
      nativeMutationCapability: "connectors.mcp.register", riskLevel: 2, metadata: { operation: "abandon_mcp_registration_preparation", kind: "mcp" } });
  } catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try {
    const result = await abandonNativeMcpRegistrationPreparationService(createRequestMutationAppServiceCaller(request, context, {
      purpose: "api.connectors.native.mcp_registration_preparation.abandon", causationId: parsed.data.intent.connectorId,
    }), parsed.data, key.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: result.data.replayed ? 200 : 201, headers: nativeConnectorHeaders });
  } catch (error) { return nativeConnectorFailureResponse(error); }
}));
