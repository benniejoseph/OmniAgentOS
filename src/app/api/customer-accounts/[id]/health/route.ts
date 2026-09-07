import {
  customerHealthEvaluateServiceInputSchema,
  customerHealthShowServiceInputSchema,
  evaluateCustomerHealthService,
  showCustomerHealthService,
} from "@/lib/app-services/customer-health";
import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import { customerAccountFailureResponse } from "@/lib/customer-success/http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

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
  const accountId = decodeURIComponent((await routeContext.params).id);
  let body: unknown;
  try {
    body = await parseJsonBody(request, 250_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
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
    return forbiddenResponse(error);
  }
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
