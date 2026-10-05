import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { readNativeConnectorCredentialPreparationService } from "@/lib/app-services/connector-credential-rotation";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { nativeConnectorCredentialReadInputSchema } from "@/lib/mobile/connector-credential-rotation-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(async (request: Request, route: { params: Promise<{ keySha256: string }> }) => {
  const parsed = nativeConnectorCredentialReadInputSchema.safeParse(await route.params);
  if (!parsed.success || [...new URL(request.url).searchParams].length) {
    return Response.json({ error: "An exact credential preparation key is required." }, { status: 400, headers: nativeConnectorHeaders });
  }
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "connector_native_preparation" }); }
  catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try {
    const result = await readNativeConnectorCredentialPreparationService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: nativeConnectorHeaders });
  } catch (error) { return nativeConnectorFailureResponse(error); }
});
