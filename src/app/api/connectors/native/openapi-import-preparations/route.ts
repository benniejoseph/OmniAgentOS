import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { prepareNativeOpenapiImportService } from "@/lib/app-services/connector-openapi-import";
import { connectorNativeOpenapiImportPrepareRequestSchema } from "@/lib/connectors/native-openapi-import-contracts";
import { nativeConnectorFailureResponse, nativeConnectorHeaders, privateConnectorResponse } from "@/lib/connectors/native-control-http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = withDatabaseRequestScope(requireIdempotencyKey(async (request: Request) => {
  if ([...new URL(request.url).searchParams].length) {
    return Response.json({ error: "OpenAPI import preparation queries are not supported." }, { status: 400, headers: nativeConnectorHeaders });
  }
  let body;
  try { body = await parseJsonBody(request, 4_100_000); }
  catch (error) { return privateConnectorResponse(jsonBodyErrorResponse(error)); }
  const parsed = connectorNativeOpenapiImportPrepareRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "An exact reviewed OpenAPI import preparation is required." }, { status: 400, headers: nativeConnectorHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({ request, action: "manage.connector", resourceType: "connector_native_preparation", resourceId: parsed.data.connectorId,
      nativeMutationCapability: "connectors.openapi.import", riskLevel: 2, metadata: { operation: "import_openapi", kind: "openapi", phase: "prepare" } });
  } catch (error) { return privateConnectorResponse(forbiddenResponse(error)); }
  try {
    const result = await prepareNativeOpenapiImportService(createRequestMutationAppServiceCaller(request, context, {
      purpose: "api.connectors.native.action", causationId: parsed.data.connectorId,
    }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: result.data.prepared.availability === "preparing" ? 202 : result.data.prepared.availability === "ready" && !result.data.replayed ? 201 : 200, headers: nativeConnectorHeaders });
  } catch (error) { return nativeConnectorFailureResponse(error); }
}));
