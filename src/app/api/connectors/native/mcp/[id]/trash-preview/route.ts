import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { previewNativeConnectorTrashService } from "@/lib/app-services/connector-trash";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { nativeConnectorTrashPreviewInputSchema } from "@/lib/mobile/connector-trash-contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(async (request: Request, route: { params: Promise<{ id: string }> }) => {
  const parsed = nativeConnectorTrashPreviewInputSchema.safeParse(await route.params);
  if (!parsed.success || [...new URL(request.url).searchParams].length) return Response.json({ error: "An exact MCP connector ID is required." }, { status: 400, headers: nativeConnectorHeaders });
  let context;
  try { context = await authorizeRequest({ request, action: "manage.connector", resourceType: "connector_native_action", resourceId: parsed.data.id }); }
  catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try {
    const result = await previewNativeConnectorTrashService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: nativeConnectorHeaders });
  } catch (error) { return nativeConnectorFailureResponse(error); }
});
