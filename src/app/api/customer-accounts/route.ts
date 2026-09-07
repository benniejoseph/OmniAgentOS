import {
  createCustomerAccountService,
  customerAccountCreateServiceInputSchema,
  customerAccountListServiceInputSchema,
  listCustomerAccountsService,
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
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "customer_account",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const parsed = customerAccountListServiceInputSchema.safeParse({
    workspaceId: url.searchParams.get("workspaceId") || undefined,
    lifecycle: url.searchParams.get("lifecycle") || undefined,
    limit: numericQuery(url.searchParams.get("limit"), 100),
  });
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  try {
    const result = await listCustomerAccountsService(
      createAppServiceCaller({ context }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return customerAccountFailureResponse(error, "list");
  }
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request, 100_000);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = customerAccountCreateServiceInputSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error.flatten());
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "customer_account",
      riskLevel: 2,
      metadata: {
        operation: "create",
        lifecycle: parsed.data.lifecycle,
        customerDataPurposeIds: parsed.data.customerDataPurposeIds,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const result = await createCustomerAccountService(
      createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.customer-account.create",
        workspaceId: parsed.data.workspaceId,
      }),
      parsed.data,
    );
    return Response.json({
      ...result.data,
      serviceReceipt: result.receipt,
    }, { status: 201, headers: privateNoStoreHeaders });
  } catch (error) {
    return customerAccountFailureResponse(error, "create");
  }
}

function invalidRequest(details: unknown) {
  return Response.json(
    { error: "Invalid customer account request.", details },
    { status: 400, headers: privateNoStoreHeaders },
  );
}

function numericQuery(value: string | null, fallback: number) {
  if (value === null || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
