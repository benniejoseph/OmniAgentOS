import {
  customerSuccessWorkflowListServiceInputSchema,
  customerSuccessWorkflowOutcomeServiceInputSchema,
  customerSuccessWorkflowStartServiceInputSchema,
  listCustomerSuccessWorkflowsService,
  recordCustomerSuccessWorkflowOutcomeService,
  startCustomerSuccessWorkflowService,
  startCustomerSuccessWorkflowNativeService,
  recordCustomerSuccessWorkflowNativeOutcomeService,
} from "@/lib/app-services/customer-success-workflows";
import {
  createAppServiceCaller,
  createRequestMutationAppServiceCaller,
} from "@/lib/app-services/contracts";
import { customerAccountFailureResponse } from "@/lib/customer-success/http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { JsonBodyError, jsonBodyErrorResponse, readRequestTextLimited } from "@/lib/http/body";
import { requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { customerSuccessWorkflowNativeAccountIdSchema, customerSuccessWorkflowNativeStartRequestSchema,
  customerSuccessWorkflowNativeOutcomeRequestSchema } from "@/lib/customer-success/workflow-mutation-contracts";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));
export const PATCH = withDatabaseRequestScope(requireIdempotencyKey(PATCHHandler));

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
  const parsedBody = await requestBody(request);
  if (parsedBody instanceof Response) return parsedBody;
  const body = parsedBody.body;
  if (typeof body === "object" && body !== null && "contract" in body) {
    return nativeMutation(request, accountId, body, parsedBody.bytes, "start");
  }
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
  if (context.source === "mobile") return Response.json({ error: "The strict native workflow request is required." }, { status: 403, headers: privateNoStoreHeaders });
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
  const parsedBody = await requestBody(request);
  if (parsedBody instanceof Response) return parsedBody;
  const body = parsedBody.body;
  if (typeof body === "object" && body !== null && "contract" in body) {
    return nativeMutation(request, accountId, body, parsedBody.bytes, "outcome");
  }
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
  if (context.source === "mobile") return Response.json({ error: "The strict native workflow request is required." }, { status: 403, headers: privateNoStoreHeaders });
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
    const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (request.body && mediaType !== "application/json" && !mediaType?.endsWith("+json")) {
      throw new JsonBodyError("JSON requests must use an application/json content type.", 415);
    }
    const body = await readRequestTextLimited(request, 250_000);
    if (body.truncated) throw new JsonBodyError("Request body is too large.", 413);
    try { return { body: body.text.trim() ? JSON.parse(body.text) as unknown : {}, bytes: body.bytesRead }; }
    catch { throw new JsonBodyError("Request body is not valid JSON."); }
  } catch (error) {
    if (!(error instanceof JsonBodyError)) return Response.json({ error: "Workflow request is temporarily unavailable." }, { status: 503, headers: privateNoStoreHeaders });
    const response = jsonBodyErrorResponse(error);
    response.headers.set("cache-control", privateNoStoreHeaders["cache-control"]);
    return response;
  }
}

async function nativeMutation(request: Request, accountId: string, body: unknown, bytes: number, operation: "start" | "outcome") {
  const maxBytes = operation === "start" ? 32_768 : 131_072;
  if (bytes > maxBytes || Number(request.headers.get("content-length") || 0) > maxBytes) {
    return Response.json({ error: "Workflow request body is too large." }, { status: 413, headers: privateNoStoreHeaders });
  }
  if ([...new URL(request.url).searchParams].length || !customerSuccessWorkflowNativeAccountIdSchema.safeParse(accountId).success) {
    return Response.json({ error: "Invalid exact native workflow target or query." }, { status: 400, headers: privateNoStoreHeaders });
  }
  const parsed = operation === "start" ? customerSuccessWorkflowNativeStartRequestSchema.safeParse(body)
    : customerSuccessWorkflowNativeOutcomeRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid native workflow request." }, { status: 400, headers: privateNoStoreHeaders });
  const value = parsed.data, start = value.contract === "customer-success-workflow-start-request:1";
  let context;
  try {
    context = await authorizeRequest({ request, action: start ? "run.agent" : "manage.workflow",
      nativeMutationCapability: start ? "customers.workflows.start" : "customers.workflows.outcomes.manage",
      resourceType: start ? "customer_success_workflow" : "customer_success_workflow_outcome",
      resourceId: start ? accountId : value.runId, riskLevel: 2,
      metadata: { operation, accountId, expectedAccountRevision: value.expectedAccountRevision, directExternalEffectsAllowed: false },
    });
  } catch (error) {
    try { const response = forbiddenResponse(error); response.headers.set("cache-control", privateNoStoreHeaders["cache-control"]); return response; }
    catch { return Response.json({ error: "Workflow authorization is temporarily unavailable." }, { status: 503, headers: privateNoStoreHeaders }); }
  }
  try {
    const caller = createRequestMutationAppServiceCaller(request, context, {
      purpose: `api.customer-success-workflow.${operation}`, workspaceId: value.workspaceId,
      causationId: start ? accountId : value.runId,
    });
    const result = value.contract === "customer-success-workflow-start-request:1"
      ? await startCustomerSuccessWorkflowNativeService(caller, { accountId, ...value })
      : await recordCustomerSuccessWorkflowNativeOutcomeService(caller, { accountId, ...value });
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, {
      status: start && !result.data.replayed ? 201 : 200, headers: privateNoStoreHeaders,
    });
  } catch (error) { return customerAccountFailureResponse(error, "native workflow mutation"); }
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
