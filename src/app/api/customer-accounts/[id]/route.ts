import {
  customerAccountReviseServiceInputSchema,
  customerAccountShowServiceInputSchema,
  reviseCustomerAccountService,
  showCustomerAccountService,
} from "@/lib/app-services/customer-accounts";
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
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
type RouteContext = { params: Promise<{ id: string }> };

async function GETHandler(request: Request, routeContext: RouteContext) {
  const accountId = decodeURIComponent((await routeContext.params).id);
  const workspaceId = new URL(request.url).searchParams.get("workspaceId") || undefined;
  const parsed = customerAccountShowServiceInputSchema.safeParse({ accountId, workspaceId });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "customer_account",
      resourceId: accountId,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await showCustomerAccountService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    if (!result.data.account) {
      return Response.json(
        { error: "Customer account was not found." },
        { status: 404, headers: privateNoStoreHeaders },
      );
    }
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return customerAccountFailureResponse(error, "show");
  }
}

async function PATCHHandler(request: Request, routeContext: RouteContext) {
  const accountId = decodeURIComponent((await routeContext.params).id);
  let body: unknown;
  try {
    body = await parseJsonBody(request, 100_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = customerAccountReviseServiceInputSchema.safeParse({
    ...(typeof body === "object" && body !== null ? body : {}),
    accountId,
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "customer_account",
      resourceId: accountId,
      riskLevel: 2,
      metadata: {
        operation: "revise",
        expectedRevision: parsed.data.expectedRevision,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await reviseCustomerAccountService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.customer-account.revise",
        workspaceId: parsed.data.workspaceId,
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return customerAccountFailureResponse(error, "revise");
  }
}

function invalidRequest(details: unknown) {
  return Response.json(
    { error: "Invalid customer account request.", details },
    { status: 400, headers: privateNoStoreHeaders },
  );
}
