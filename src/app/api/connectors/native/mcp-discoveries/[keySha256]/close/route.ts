import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { closeNativeMcpDiscoveryService } from "@/lib/app-services/connector-mcp-discovery";
import { connectorNativeMcpDiscoveryCloseRequestSchema } from "@/lib/connectors/native-mcp-discovery-contracts";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { nativeConnectorMcpDiscoveryReadInputSchema } from "@/lib/mobile/connector-mcp-discovery-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const POST = withDatabaseRequestScope(requireIdempotencyKey(async (request: Request, route: { params: Promise<{ keySha256: string }> }) => {
  const key = nativeConnectorMcpDiscoveryReadInputSchema.safeParse(await route.params);
  if (!key.success || [...new URL(request.url).searchParams].length) {
    return Response.json({ error: "An exact MCP discovery closure key is required." }, { status: 400, headers: nativeConnectorHeaders });
  }
  let body;
  try { body = await parseJsonBody(request, 16_384); }
  catch (error) { return privateConnectorResponse(jsonBodyErrorResponse(error)); }
  const parsed = connectorNativeMcpDiscoveryCloseRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "The original safe MCP discovery intent is required." }, { status: 400, headers: nativeConnectorHeaders });
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "connector_native_discovery", resourceId: parsed.data.intent.request.connectorId,
      nativeMutationCapability: "connectors.mcp.discover", riskLevel: 0, metadata: { operation: "close_mcp_discovery", kind: "mcp" } });
  } catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try {
    const result = await closeNativeMcpDiscoveryService(createRequestMutationAppServiceCaller(request, context, {
      purpose: "api.connectors.native.mcp_discovery_close", causationId: parsed.data.intent.request.connectorId,
    }), parsed.data, key.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: result.data.replayed ? 200 : 201, headers: nativeConnectorHeaders });
  } catch (error) { return nativeConnectorFailureResponse(error); }
}));
