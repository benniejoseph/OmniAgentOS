import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { readNativeConnectorActionService } from "@/lib/app-services/connector-native";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { nativeConnectorReadInputSchema } from "@/lib/mobile/connector-native-contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(async (request: Request, route: { params: Promise<{ keySha256: string }> }) => {
  const parsed = nativeConnectorReadInputSchema.safeParse(await route.params);
  if (!parsed.success || [...new URL(request.url).searchParams].length) return Response.json({ error: "An exact connector action key is required." }, { status: 400, headers: nativeConnectorHeaders });
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "connector_native_action" }); }
  catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try { const result = await readNativeConnectorActionService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: nativeConnectorHeaders }); }
  catch (error) { return nativeConnectorFailureResponse(error); }
});
