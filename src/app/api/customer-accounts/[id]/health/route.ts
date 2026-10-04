import {
  customerHealthEvaluateServiceInputSchema,
  customerHealthShowServiceInputSchema,
  evaluateCustomerHealthService,
  evaluateCustomerHealthNativeService,
  showCustomerHealthService,
} from "@/lib/app-services/customer-health";
import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import { customerAccountFailureResponse } from "@/lib/customer-success/http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { JsonBodyError, jsonBodyErrorResponse, readRequestTextLimited } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { CustomerHealthEvaluationRefusedError } from "@/lib/customer-success/health-store";
import {
  nativeCustomerHealthEvaluateRequestSchema,
  nativeCustomerHealthEvaluationRefusalSchema,
} from "@/lib/mobile/customer-health-mutation-contracts";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
type RouteContext = { params: Promise<{ id: string }> };

async function GETHandler(request: Request, routeContext: RouteContext) {
  const accountId = decodeURIComponent((await routeContext.params).id);
  const url = new URL(request.url);
  const parsed = customerHealthShowServiceInputSchema.safeParse({
    accountId,
    workspaceId: url.searchParams.get("workspaceId") || undefined,
    historyLimit: numericQuery(url.searchParams.get("historyLimit"), 20),
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "customer_health_score",
      resourceId: accountId,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await showCustomerHealthService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return customerAccountFailureResponse(error, "health read");
  }
}

async function POSTHandler(request: Request, routeContext: RouteContext) {
  let accountId: string;
  try { accountId = decodeURIComponent((await routeContext.params).id); }
  catch { return nativeInvalidRequest(); }
  let body: unknown;
  let bytesRead: number;
  try {
    ({ body, bytesRead } = await readHealthBody(request));
  } catch (error) {
    return privateResponse(jsonBodyErrorResponse(error));
  }
  const versioned = typeof body === "object" && body !== null && "contract" in body;
  if (versioned) {
    if (bytesRead > 4_096 || Number(request.headers.get("content-length") || 0) > 4_096) {
      return privateResponse(jsonBodyErrorResponse(new JsonBodyError("Request body is too large.", 413)));
    }
    if ([...new URL(request.url).searchParams].length || !/^customer-account:[a-f0-9]{64}$/.test(accountId)) return nativeInvalidRequest();
    const parsed = nativeCustomerHealthEvaluateRequestSchema.safeParse(body);
    if (!parsed.success) return nativeInvalidRequest();
    let context;
    try {
      context = await authorizeRequest({ request, action: "manage.workflow",
        nativeMutationCapability: "customers.health.evaluate", resourceType: "customer_health_score",
        resourceId: accountId, riskLevel: 1, metadata: { operation: "evaluate", expectedAccountRevision: parsed.data.expectedAccountRevision, modelSuggestionCount: 0 } });
    } catch (error) {
      try { return privateResponse(forbiddenResponse(error)); }
      catch { return Response.json({ error: "Customer health authorization is temporarily unavailable.", code: "customer_health_unavailable" },
        { status: 503, headers: privateNoStoreHeaders }); }
    }
    try {
      const result = await evaluateCustomerHealthNativeService(createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.customer-health.evaluate", workspaceId: parsed.data.workspaceId, causationId: accountId,
      }), { ...parsed.data, accountId });
      return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
        status: result.data.replayed ? 200 : 201, headers: privateNoStoreHeaders,
      });
    } catch (error) {
      if (error instanceof CustomerHealthEvaluationRefusedError) {
        const refusal = nativeCustomerHealthEvaluationRefusalSchema.safeParse({
          contract: "customer-health-evaluation-refusal:1", error: error.message, code: error.code,
          admission: "not_admitted", evaluationId: error.evaluationId, requestSha256: error.requestSha256,
        });
        if (refusal.success) return Response.json(refusal.data, { status: 409, headers: privateNoStoreHeaders });
      }
      return customerAccountFailureResponse(error, "health evaluation");
    }
  }
  const parsed = customerHealthEvaluateServiceInputSchema.safeParse({
    ...(typeof body === "object" && body !== null ? body : {}),
    accountId,
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "customer_health_score",
      resourceId: accountId,
      riskLevel: 1,
      metadata: {
        operation: "evaluate",
        expectedAccountRevision: parsed.data.expectedAccountRevision,
        modelSuggestionCount: parsed.data.modelSuggestions.length,
      },
    });
  } catch (error) {
    return privateResponse(forbiddenResponse(error));
  }
  if (context.source === "mobile") return Response.json({ error: "The versioned native health evaluation contract is required.",
    code: "customer_health_contract_required" }, { status: 403, headers: privateNoStoreHeaders });
  try {
    const result = await evaluateCustomerHealthService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.customer-health.evaluate",
        workspaceId: parsed.data.workspaceId,
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { status: 201, headers: privateNoStoreHeaders });
  } catch (error) {
    return customerAccountFailureResponse(error, "health evaluation");
  }
}

// Both forms share a URL. Retain the legacy allowance while counting the exact
// UTF-8 request bytes so the explicitly versioned form has its smaller bound.
async function readHealthBody(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (request.body && contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new JsonBodyError("JSON requests must use an application/json content type.", 415);
  }
  if (Number(request.headers.get("content-length") || 0) > 250_000) throw new JsonBodyError("Request body is too large.", 413);
  const raw = await readRequestTextLimited(request, 250_000);
  if (raw.truncated) throw new JsonBodyError("Request body is too large.", 413);
  let body: unknown = {};
  if (raw.text.trim()) {
    try { body = JSON.parse(raw.text); }
    catch { throw new JsonBodyError("Request body is not valid JSON."); }
  }
  return { body, bytesRead: raw.bytesRead };
}
function nativeInvalidRequest() {
  return Response.json({ error: "Invalid native customer health evaluation request.", code: "customer_health_request_invalid" },
    { status: 400, headers: privateNoStoreHeaders });
}
function privateResponse(response: Response) {
  response.headers.set("cache-control", privateNoStoreHeaders["cache-control"]);
  return response;
}

function invalidRequest(details: unknown) {
  return Response.json(
    { error: "Invalid customer health request.", details },
    { status: 400, headers: privateNoStoreHeaders },
  );
}

function numericQuery(value: string | null, fallback: number) {
  if (value === null || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
