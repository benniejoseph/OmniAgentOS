import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { readNativeMcpDiscoveryService } from "@/lib/app-services/connector-mcp-discovery";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { nativeConnectorMcpDiscoveryReadInputSchema } from "@/lib/mobile/connector-mcp-discovery-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(async (request: Request, route: { params: Promise<{ keySha256: string }> }) => {
  const parsed = nativeConnectorMcpDiscoveryReadInputSchema.safeParse(await route.params);
  if (!parsed.success || [...new URL(request.url).searchParams].length) {
    return Response.json({ error: "An exact MCP discovery recovery key is required." }, { status: 400, headers: nativeConnectorHeaders });
  }
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "connector_native_discovery", resourceId: parsed.data.keySha256 }); }
  catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try {
    const result = await readNativeMcpDiscoveryService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: nativeConnectorHeaders });
  } catch (error) { return nativeConnectorFailureResponse(error); }
});
