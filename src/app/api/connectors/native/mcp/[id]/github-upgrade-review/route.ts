import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { reviewNativeGithubUpgradeService } from "@/lib/app-services/connector-github-upgrade";
import { connectorNativeIdSchema } from "@/lib/connectors/native-control-contracts";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(async (
  request: Request, route: { params: Promise<{ id: string }> },
) => {
  const parsed = connectorNativeIdSchema.safeParse((await route.params).id);
  if (!parsed.success || [...new URL(request.url).searchParams].length) {
    return Response.json({ error: "An exact MCP connector id is required." },
      { status: 400, headers: nativeConnectorHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector",
      resourceType: "connector_native_upgrade", resourceId: parsed.data });
  } catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try {
    const result = await reviewNativeGithubUpgradeService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt },
      { headers: nativeConnectorHeaders });
  } catch (error) { return nativeConnectorFailureResponse(error); }
});
