import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { reviewSalesforceNativeActionsService, submitSalesforceNativeActionService } from "@/lib/app-services/salesforce-native";
import { salesforceNativeRequestSchema } from "@/lib/customer-success/salesforce-native-contracts";
import { salesforceNativeFailureResponse } from "@/lib/customer-success/salesforce-native-http";
import { nativeSalesforceActionQuerySchema } from "@/lib/mobile/salesforce-native-contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 300;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));
const headers = { "cache-control": "private, no-store" };
function privateResponse(response: Response) { response.headers.set("cache-control", headers["cache-control"]); return response; }
async function GETHandler(request: Request) {
  const entries = [...new URL(request.url).searchParams], parsed = nativeSalesforceActionQuerySchema.safeParse(Object.fromEntries(entries));
  if (!parsed.success || entries.length !== 1 || entries[0][0] !== "workspaceId") return Response.json({ error: "An exact Salesforce workspace is required." }, { status: 400, headers });
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "salesforce_connection" }); }
  catch (error) { return privateResponse(forbiddenResponse(error)); }
  try { const result = await reviewSalesforceNativeActionsService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers }); }
  catch (error) { return salesforceNativeFailureResponse(error); }
}
async function POSTHandler(request: Request) {
  if ([...new URL(request.url).searchParams].length) return Response.json({ error: "Salesforce action queries are not supported." }, { status: 400, headers });
  let body;
  try { body = await parseJsonBody(request, 16_384); }
  catch (error) { return privateResponse(jsonBodyErrorResponse(error)); }
  const parsed = salesforceNativeRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "An exact reviewed Salesforce action is required." }, { status: 400, headers });
  let context;
  try { context = await authorizeRequest({ request, action: "manage.connector", resourceType: "salesforce_connection", resourceId: parsed.data.review.connectionId,
    nativeMutationCapability: "customers.salesforce.manage", riskLevel: 2,
    metadata: { operation: parsed.data.action, authorizationGeneration: parsed.data.review.authorizationGeneration } }); }
  catch (error) { return privateResponse(forbiddenResponse(error)); }
  try { const result = await submitSalesforceNativeActionService(createRequestMutationAppServiceCaller(request, context, {
    purpose: "api.customer-salesforce.action", workspaceId: parsed.data.workspaceId, causationId: parsed.data.review.connectionId,
  }), parsed.data, request.signal);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: result.data.replayed ? 200 : 201, headers }); }
  catch (error) { return salesforceNativeFailureResponse(error); }
}
