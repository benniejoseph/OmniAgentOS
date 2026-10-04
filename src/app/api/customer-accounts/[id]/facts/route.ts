import {
  customerFactRecordServiceInputSchema,
  recordCustomerFactService,
} from "@/lib/app-services/customer-accounts";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { recordCustomerFactNativeService } from "@/lib/app-services/customer-facts";
import { customerFactNativeAccountIdSchema, customerFactNativeRequestSchema } from "@/lib/customer-success/fact-mutation-contracts";
import { customerAccountFailureResponse } from "@/lib/customer-success/http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { JsonBodyError, jsonBodyErrorResponse, readRequestTextLimited } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
type RouteContext = { params: Promise<{ id: string }> };

async function POSTHandler(request: Request, routeContext: RouteContext) {
  let accountId: string;
  try { accountId = decodeURIComponent((await routeContext.params).id); }
  catch { return invalidNativeRequest(); }
  let body: unknown;
  let bytesRead: number;
  try {
    const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (request.body && type !== "application/json" && !type?.endsWith("+json")) throw new JsonBodyError("JSON content type is required.", 415);
    if (Number(request.headers.get("content-length") || 0) > 250_000) throw new JsonBodyError("Request body is too large.", 413);
    const raw = await readRequestTextLimited(request, 250_000);
    if (raw.truncated) throw new JsonBodyError("Request body is too large.", 413);
    bytesRead = raw.bytesRead;
    try { body = raw.text.trim() ? JSON.parse(raw.text) : {}; }
    catch { throw new JsonBodyError("Request body is not valid JSON."); }
  } catch (error) {
    return privateResponse(jsonBodyErrorResponse(error));
  }
  if (typeof body === "object" && body !== null && "contract" in body) {
    if (bytesRead > 65_536) return privateResponse(jsonBodyErrorResponse(new JsonBodyError("Request body is too large.", 413)));
    const parsed = customerFactNativeRequestSchema.safeParse(body);
    if (!parsed.success || !customerFactNativeAccountIdSchema.safeParse(accountId).success || [...new URL(request.url).searchParams].length) return invalidNativeRequest();
    let context;
    try {
      context = await authorizeRequest({ request, action: "manage.workflow", nativeMutationCapability: "customers.facts.mutate",
        resourceType: "customer_account_fact", resourceId: accountId, riskLevel: 2,
        metadata: { operation: parsed.data.operation, factKind: parsed.data.value.kind, sourceKind: "manual", expectedRevision: parsed.data.expectedFactRevision } });
    } catch (error) { return privateResponse(forbiddenResponse(error)); }
    try {
      const result = await recordCustomerFactNativeService(createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.customer-account.fact.record", workspaceId: parsed.data.workspaceId, causationId: accountId,
      }), { ...parsed.data, accountId });
      return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: result.data.replayed ? 200 : 201, headers: privateNoStoreHeaders });
    } catch (error) { return customerAccountFailureResponse(error, "manual fact record"); }
  }
  const parsed = customerFactRecordServiceInputSchema.safeParse({
    ...(typeof body === "object" && body !== null ? body : {}),
    accountId,
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid customer fact request.", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "customer_account_fact",
      resourceId: accountId,
      riskLevel: 2,
      metadata: {
        operation: "record",
        factKind: parsed.data.value.kind,
        sourceKind: parsed.data.source.sourceKind,
        expectedRevision: parsed.data.expectedRevision || null,
      },
    });
  } catch (error) {
    return privateResponse(forbiddenResponse(error));
  }
  if (context.source === "mobile") return Response.json({ error: "The versioned native manual fact contract is required.",
    code: "customer_fact_contract_required" }, { status: 403, headers: privateNoStoreHeaders });
  try {
    const result = await recordCustomerFactService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.customer-account.fact.record",
        workspaceId: parsed.data.workspaceId,
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { status: 201, headers: privateNoStoreHeaders });
  } catch (error) {
    return customerAccountFailureResponse(error, "fact record");
  }
}

function invalidNativeRequest() {
  return Response.json({ error: "Invalid native manual fact request.", code: "customer_fact_request_invalid" }, { status: 400, headers: privateNoStoreHeaders });
}
function privateResponse(response: Response) {
  response.headers.set("cache-control", privateNoStoreHeaders["cache-control"]); return response;
}
