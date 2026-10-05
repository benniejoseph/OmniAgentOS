import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { reviewNativeConnectorService } from "@/lib/app-services/connector-native";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { nativeConnectorReviewInputSchema } from "@/lib/mobile/connector-native-contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(async (request: Request, route: { params: Promise<{ kind: string; id: string }> }) => {
  const parsed = nativeConnectorReviewInputSchema.safeParse(await route.params);
  if (!parsed.success || [...new URL(request.url).searchParams].length) return Response.json({ error: "An exact connector review target is required." }, { status: 400, headers: nativeConnectorHeaders });
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "connector_native_action", resourceId: parsed.data.id }); }
  catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try { const result = await reviewNativeConnectorService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: nativeConnectorHeaders }); }
  catch (error) { return nativeConnectorFailureResponse(error); }
});
