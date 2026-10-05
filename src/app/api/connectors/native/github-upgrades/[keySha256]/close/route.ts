import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { closeNativeGithubUpgradeService } from "@/lib/app-services/connector-github-upgrade";
import { connectorNativeGithubUpgradeCloseRequestSchema } from "@/lib/connectors/native-github-upgrade-contracts";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { nativeConnectorGithubUpgradeReadInputSchema } from "@/lib/mobile/connector-github-upgrade-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const POST = withDatabaseRequestScope(requireIdempotencyKey(async (
  request: Request, route: { params: Promise<{ keySha256: string }> },
) => {
  const key = nativeConnectorGithubUpgradeReadInputSchema.safeParse(await route.params);
  if (!key.success || [...new URL(request.url).searchParams].length) {
    return Response.json({ error: "An exact GitHub upgrade close key is required." },
      { status: 400, headers: nativeConnectorHeaders });
  }
  let body;
  try { body = await parseJsonBody(request, 16_384); }
  catch (error) { return privateConnectorResponse(jsonBodyErrorResponse(error)); }
  const parsed = connectorNativeGithubUpgradeCloseRequestSchema.safeParse(body);
  if (!parsed.success || parsed.data.intent.keySha256 !== key.data.keySha256) {
    return Response.json({ error: "The original safe GitHub upgrade intent and key are required." },
      { status: 400, headers: nativeConnectorHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({ request, action: "read",
      resourceType: "connector_native_upgrade", resourceId: parsed.data.intent.request.connectorId,
      nativeMutationCapability: "connectors.github.upgrade", riskLevel: 0,
      metadata: { operation: "close_github_upgrade", kind: "mcp" } });
  } catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try {
    const result = await closeNativeGithubUpgradeService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.connectors.native.github_upgrade_close",
        causationId: parsed.data.intent.request.connectorId,
      }), parsed.data, key.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt },
      { status: result.data.replayed ? 200 : 201, headers: nativeConnectorHeaders });
  } catch (error) { return nativeConnectorFailureResponse(error); }
}));
