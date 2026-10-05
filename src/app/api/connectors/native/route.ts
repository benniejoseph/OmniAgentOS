import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { listNativeConnectorsService } from "@/lib/app-services/connector-native";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(async (request: Request) => {
  if ([...new URL(request.url).searchParams].length) return Response.json({ error: "Connector list queries are not supported." }, { status: 400, headers: nativeConnectorHeaders });
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "connector_native_action" }); }
  catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try { const result = await listNativeConnectorsService(createAppServiceCaller({ context }));
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: nativeConnectorHeaders }); }
  catch (error) { return nativeConnectorFailureResponse(error); }
});
