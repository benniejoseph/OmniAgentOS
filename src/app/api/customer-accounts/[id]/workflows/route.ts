import {
  customerSuccessWorkflowListServiceInputSchema,
  customerSuccessWorkflowOutcomeServiceInputSchema,
  customerSuccessWorkflowStartServiceInputSchema,
  listCustomerSuccessWorkflowsService,
  recordCustomerSuccessWorkflowOutcomeService,
  startCustomerSuccessWorkflowService,
} from "@/lib/app-services/customer-success-workflows";
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
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
type RouteContext = { params: Promise<{ id: string }> };

async function GETHandler(request: Request, routeContext: RouteContext) {
  const accountId = decodeURIComponent((await routeContext.params).id);
  const url = new URL(request.url);
  const parsed = customerSuccessWorkflowListServiceInputSchema.safeParse({
    accountId,
    workspaceId: url.searchParams.get("workspaceId") || undefined,
    limit: numericQuery(url.searchParams.get("limit"), 50),
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "customer_success_workflow",
      resourceId: accountId,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await listCustomerSuccessWorkflowsService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return customerAccountFailureResponse(error, "workflow read");
  }
}

async function POSTHandler(request: Request, routeContext: RouteContext) {
  const accountId = decodeURIComponent((await routeContext.params).id);
  const body = await requestBody(request);
  if (body instanceof Response) return body;
  const parsed = customerSuccessWorkflowStartServiceInputSchema.safeParse({
    ...(typeof body === "object" && body !== null ? body : {}),
    accountId,
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "customer_success_workflow",
      resourceId: accountId,
      riskLevel: 2,
      metadata: {
        operation: "start",
        workflowId: parsed.data.input.workflowId,
        expectedAccountRevision: parsed.data.expectedAccountRevision,
        directExternalEffectsAllowed: false,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await startCustomerSuccessWorkflowService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.customer-success-workflow.start",
        workspaceId: parsed.data.workspaceId,
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { status: 201, headers: privateNoStoreHeaders });
  } catch (error) {
    return customerAccountFailureResponse(error, "workflow start");
  }
}

async function PATCHHandler(request: Request, routeContext: RouteContext) {
  const accountId = decodeURIComponent((await routeContext.params).id);
  const body = await requestBody(request);
  if (body instanceof Response) return body;
  const parsed = customerSuccessWorkflowOutcomeServiceInputSchema.safeParse({
    ...(typeof body === "object" && body !== null ? body : {}),
    accountId,
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "customer_success_workflow_outcome",
      resourceId: parsed.data.runId,
      riskLevel: 2,
      metadata: {
        operation: "record_outcome",
        accountId,
        expectedRevision: parsed.data.expectedRevision,
        outcomeStatus: parsed.data.status,
        artifactReceiptCount: parsed.data.artifactReceipts.length,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await recordCustomerSuccessWorkflowOutcomeService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.customer-success-workflow.outcome",
        workspaceId: parsed.data.workspaceId,
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return customerAccountFailureResponse(error, "workflow outcome");
  }
}

async function requestBody(request: Request) {
  try {
    return await parseJsonBody(request, 250_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
}

function invalidRequest(details: unknown) {
  return Response.json(
    { error: "Invalid customer-success workflow request.", details },
    { status: 400, headers: privateNoStoreHeaders },
  );
}

function numericQuery(value: string | null, fallback: number) {
  if (value === null || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
