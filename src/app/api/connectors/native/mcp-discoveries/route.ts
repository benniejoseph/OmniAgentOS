import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { submitNativeMcpDiscoveryService } from "@/lib/app-services/connector-mcp-discovery";
import { connectorNativeMcpDiscoveryRequestSchema } from "@/lib/connectors/native-mcp-discovery-contracts";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = withDatabaseRequestScope(requireIdempotencyKey(async (request: Request) => {
  if ([...new URL(request.url).searchParams].length) {
    return Response.json({ error: "MCP discovery queries are not supported." }, { status: 400, headers: nativeConnectorHeaders });
  }
  let body;
  try { body = await parseJsonBody(request, 8192); }
  catch (error) { return privateConnectorResponse(jsonBodyErrorResponse(error)); }
  const parsed = connectorNativeMcpDiscoveryRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "An exact reviewed MCP discovery is required." }, { status: 400, headers: nativeConnectorHeaders });
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "connector_native_discovery", resourceId: parsed.data.connectorId,
      nativeMutationCapability: "connectors.mcp.discover", riskLevel: 2, metadata: { operation: "discover_mcp", kind: "mcp" } });
  } catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try {
    const result = await submitNativeMcpDiscoveryService(createRequestMutationAppServiceCaller(request, context, {
      purpose: "api.connectors.native.mcp_discovery", causationId: parsed.data.connectorId,
    }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: result.data.replayed ? 200 : 201, headers: nativeConnectorHeaders });
  } catch (error) { return nativeConnectorFailureResponse(error); }
}));
